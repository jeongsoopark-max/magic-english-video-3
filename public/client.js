// client.js — browser-side WebRTC mesh logic.
//
// Topology: full mesh. Whoever joins a room LAST connects out to every
// peer already in the room (creates the offer). Existing peers just
// answer. Fine for the target size of this tool (up to ~10 people);
// don't scale this pattern much past that without moving to an SFU.

// ---- ICE server config -------------------------------------------------
// The public STUN server below is enough on most home/office networks.
// Some networks (strict school/corporate firewalls, symmetric NAT) will
// NOT connect with STUN alone and need a TURN server relay. If students
// report "connecting..." that never finishes, add TURN credentials here.
// See README.md for free/paid TURN options.
// Default to STUN-only; the server may hand us a TURN relay too (see /api/turn).
// TURN is what keeps mobile-carrier (symmetric NAT / CGNAT) and in-app-browser
// students connected. We fetch it once at startup and again before each join.
let ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
];

let _iceServersReady = null;
function ensureIceServers() {
  if (_iceServersReady) return _iceServersReady;
  _iceServersReady = fetch('/api/turn', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (data && Array.isArray(data.iceServers) && data.iceServers.length) {
        ICE_SERVERS = data.iceServers;
      }
    })
    .catch(() => { /* keep STUN-only fallback */ });
  return _iceServersReady;
}
ensureIceServers(); // warm it up immediately on page load

const socket = io();

// DOM refs
const joinScreen = document.getElementById('join-screen');
const waitingScreen = document.getElementById('waiting-screen');
const callScreen = document.getElementById('call-screen');
const nameInput = document.getElementById('name-input');
const roomInput = document.getElementById('room-input');
const generateRoomBtn = document.getElementById('generate-room-btn');
const approvalCheckbox = document.getElementById('approval-checkbox');
const joinBtn = document.getElementById('join-btn');
const joinError = document.getElementById('join-error');
const cancelWaitBtn = document.getElementById('cancel-wait-btn');
const roomLabel = document.getElementById('room-label');
const participantCount = document.getElementById('participant-count');
const pendingBtn = document.getElementById('pending-btn');
const pendingPanel = document.getElementById('pending-panel');
const pendingCount = document.getElementById('pending-count');
const videoGrid = document.getElementById('video-grid');
const micBtn = document.getElementById('mic-btn');
const camBtn = document.getElementById('cam-btn');
const screenBtn = document.getElementById('screen-btn');
const bgBtn = document.getElementById('bg-btn');
const bgPanel = document.getElementById('bg-panel');
const bgSourceVideo = document.getElementById('bg-source-video');
const bgCanvas = document.getElementById('bg-canvas');
const leaveBtn = document.getElementById('leave-btn');
const toggleChatBtn = document.getElementById('toggle-chat-btn');
const chatPanel = document.getElementById('chat-panel');
const chatLog = document.getElementById('chat-log');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const boardOnlyCheckbox = document.getElementById('board-only-checkbox');
const callMain = document.querySelector('.call-main');

// Whiteboard DOM
const whiteboardBtn = document.getElementById('whiteboard-btn');
const whiteboardPanel = document.getElementById('whiteboard-panel');
const wbCanvas = document.getElementById('wb-canvas');
const wbPdfCanvas = document.getElementById('wb-pdf-canvas');
const wbSizeInput = document.getElementById('wb-size');
const wbPenBtn = document.getElementById('wb-pen-btn');
const wbPencilBtn = document.getElementById('wb-pencil-btn');
const wbEraserBtn = document.getElementById('wb-eraser-btn');
// 하단 컨트롤 바와, 필기 열릴 때 컨트롤이 이동할 상단 툴바 자리.
const controlsBar = document.querySelector('.controls-bar');
const wbCallControls = document.getElementById('wb-call-controls');
const wbClearBtn = document.getElementById('wb-clear-btn');
const wbCloseBtn = document.getElementById('wb-close-btn');
const wbAddPdfBtn = document.getElementById('wb-add-pdf-btn');
const wbAddBlankBtn = document.getElementById('wb-add-blank-btn');
const wbPdfInput = document.getElementById('wb-pdf-input');
const wbPrevBtn = document.getElementById('wb-prev-btn');
const wbNextBtn = document.getElementById('wb-next-btn');
const wbPageIndicator = document.getElementById('wb-page-indicator');
const wbLoading = document.getElementById('wb-loading');
const wbSharePngBtn = document.getElementById('wb-share-png-btn');
const wbSharePdfBtn = document.getElementById('wb-share-pdf-btn');
const wbHiBtn = document.getElementById('wb-hi-btn');
const wbPanBtn = document.getElementById('wb-pan-btn');
const wbReadSelBtn = document.getElementById('wb-readsel-btn');
const wbZoomInBtn = document.getElementById('wb-zoom-in-btn');
const wbZoomOutBtn = document.getElementById('wb-zoom-out-btn');
const wbZoomFitBtn = document.getElementById('wb-zoom-fit-btn');
const wbZoomIndicator = document.getElementById('wb-zoom-indicator');
// Whiteboard participant-strip layout buttons + "share full PDF" button.
// (These exist in class.html and have CSS, but were previously unwired.)
const wbLayoutBottomBtn = document.getElementById('wb-layout-bottom-btn');
const wbLayoutRightBtn = document.getElementById('wb-layout-right-btn');
const wbLayoutTopBtn = document.getElementById('wb-layout-top-btn');
const wbSharePdfFileBtn = document.getElementById('wb-share-pdf-file-btn');

// State
let localStream = null;      // camera + mic, from getUserMedia
let screenStream = null;     // active only while screen-sharing
let sharingScreen = false;
let myName = '';
let currentRoom = null;
let isHost = false;
let whiteboardOnlyMode = false;   // this device joined as an iPad drawing tablet
let enteredCall = false;          // true once we're actually on the call screen
let resumeToken = null;           // room-scoped token to skip re-approval on reconnect
let lastJoin = null;              // last successful join params, for auto-rejoin
let firstConnect = true;          // ignore the very first socket 'connect'
let pendingList = [];              // host-only: people waiting for admission
const peerConnections = new Map(); // socketId -> RTCPeerConnection
const peerNames = new Map();       // socketId -> name

// ---- Audio settings/diagnostics module (audio-controls.js) --------------
// Wires the "오디오 설정·진단" panel + remote speaking indicators. Init runs
// once, the first time we actually enter a call as an A/V participant.
let audioControlsReady = false;

// ---- Spotlight (screen-share) layout state -------------------------------
// null = nobody sharing (normal grid). Otherwise 'local' or a peer's socket
// id — whoever's screen is currently shown large, with everyone else
// shrunk into a thumbnail strip.
let activeScreenShareId = null;

// ---- Spotlight layout preferences (position of the thumbnail strip + its
// size). Persisted in localStorage so the teacher/student doesn't have to
// redo it every class.
let thumbPosition = 'bottom'; // 'bottom' | 'right' | 'top'
let thumbBottomSize = 140;    // px height of the strip when it's at the bottom
let thumbRightSize = 220;     // px width of the strip when it's on the right

(function loadLayoutPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem('vc_layout_prefs') || 'null');
    if (!saved) return;
    if (saved.position === 'bottom' || saved.position === 'right' || saved.position === 'top') thumbPosition = saved.position;
    if (typeof saved.bottomSize === 'number') thumbBottomSize = clamp(saved.bottomSize, 90, 360);
    if (typeof saved.rightSize === 'number') thumbRightSize = clamp(saved.rightSize, 140, 480);
  } catch (e) { /* localStorage unavailable — just use the defaults */ }
})();

function saveLayoutPrefs() {
  try {
    localStorage.setItem('vc_layout_prefs', JSON.stringify({
      position: thumbPosition,
      bottomSize: thumbBottomSize,
      rightSize: thumbRightSize,
    }));
  } catch (e) { /* ignore */ }
}

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

// ---- Whiteboard participant-strip layout (kept separate from the
// screen-share spotlight so the two don't interfere). Position can be the
// bottom (default), the right side, or the top-centre — the last one keeps
// the students right under the webcam so the teacher looks at the camera. ---
let wbThumbPosition = 'bottom'; // 'bottom' | 'right' | 'top'
let wbBottomSize = 130;         // px height of the strip when at bottom or top
let wbRightSize = 240;          // px width of the strip when on the right

(function loadWbLayoutPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem('vc_wb_layout_prefs') || 'null');
    if (!saved) return;
    if (saved.position === 'bottom' || saved.position === 'right' || saved.position === 'top') {
      wbThumbPosition = saved.position;
    }
    if (typeof saved.bottomSize === 'number') wbBottomSize = clamp(saved.bottomSize, 90, 320);
    if (typeof saved.rightSize === 'number') wbRightSize = clamp(saved.rightSize, 160, 480);
  } catch (e) { /* use defaults */ }
})();

function saveWbLayoutPrefs() {
  try {
    localStorage.setItem('vc_wb_layout_prefs', JSON.stringify({
      position: wbThumbPosition,
      bottomSize: wbBottomSize,
      rightSize: wbRightSize,
    }));
  } catch (e) { /* ignore */ }
}

// ---- Virtual background state ------------------------------------------
// currentBgMode: 'none' | 'blur' | 'cafe' | 'study' | 'living'
let currentBgMode = 'none';
let vbgStream = null;        // canvas.captureStream() output while a background is active
let vbgRafId = null;
let selfieSegmenter = null;
let selfieSegmenterFailed = false;
const bgCtx = bgCanvas.getContext('2d');
const BG_IMAGE_PATHS = {
  study: 'backgrounds/study.png',
  office: 'backgrounds/office.png',
  simple: 'backgrounds/simple.png',
  cafe: 'backgrounds/cafe.png',
  living: 'backgrounds/living.png',
  nook: 'backgrounds/nook.png',
  cozy: 'backgrounds/cozy.png',
  shelf: 'backgrounds/bright_shelf.png',
  lake1: 'backgrounds/lake1.png',
  lake2: 'backgrounds/lake2.png',
};
const bgImageCache = {}; // mode -> HTMLImageElement (preloaded)
Object.entries(BG_IMAGE_PATHS).forEach(([mode, path]) => {
  const img = new Image();
  img.src = path;
  bgImageCache[mode] = img;
});

generateRoomBtn.addEventListener('click', () => {
  roomInput.value = 'class-' + Math.random().toString(36).slice(2, 7);
});

// Deep-link support: a page like index.html?room=advanced pre-fills the
// room code. Handy for putting a separate "입장" button per class level
// on an external homepage (e.g. a Google Sites page) — each button just
// links to a different ?room= value, students only type their name.
(function prefillRoomFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const roomParam = params.get('room');
  if (roomParam) roomInput.value = roomParam;
  // ?board=1 pre-selects "필기 전용" (handy for a bookmark on the iPad).
  if (params.get('board') === '1' && boardOnlyCheckbox) {
    boardOnlyCheckbox.checked = true;
  }
})();

joinBtn.addEventListener('click', joinRoom);
[nameInput, roomInput].forEach((el) =>
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); })
);

async function joinRoom() {
  joinError.textContent = '';
  const name = nameInput.value.trim() || 'Guest';
  const roomId = roomInput.value.trim();
  const requireApproval = approvalCheckbox.checked;
  whiteboardOnlyMode = !!(boardOnlyCheckbox && boardOnlyCheckbox.checked);

  if (!roomId) {
    joinError.textContent = '수업 코드를 입력해주세요.';
    return;
  }

  // Whiteboard-only device (iPad): no camera/mic at all — it just draws.
  if (whiteboardOnlyMode) {
    myName = name;
    currentRoom = roomId;
    lastJoin = { roomId, name, requireApproval, whiteboardOnly: true };
    socket.emit('join-room', { roomId, name, requireApproval, whiteboardOnly: true }, (res) => {
      if (!res || !res.ok) {
        joinError.textContent = '입장에 실패했어요. 다시 시도해주세요.';
        currentRoom = null;
        return;
      }
      if (res.resumeToken) resumeToken = res.resumeToken;
      isHost = false;
      document.body.classList.add('wb-only');
      enterCallScreen([], res.sharingPeerId, res.whiteboard);
      // The iPad opens the board for everyone as soon as it joins.
      openWhiteboard(true);
    });
    return;
  }

  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    // getUserMedia 자체가 없는 경우 = 카카오톡 등 인앱브라우저일 가능성이 높다.
    joinError.textContent =
      '이 브라우저에서는 카메라·마이크를 쓸 수 없어요. 크롬 또는 사파리로 열어주세요.';
    return;
  }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    joinError.textContent =
      (err && err.name === 'NotAllowedError')
        ? '카메라/마이크 접근을 허용해주세요.'
        : '카메라/마이크를 사용할 수 없어요. 다른 앱이 사용 중인지 확인하거나 크롬/사파리로 열어주세요.';
    return;
  }

  myName = name;
  currentRoom = roomId;
  lastJoin = { roomId, name, requireApproval };

  socket.emit('join-room', { roomId, name, requireApproval }, (res) => {
    if (!res.ok) {
      joinError.textContent = res.error === 'room-full'
        ? `이 수업 코드는 이미 ${res.maxSize}명이 참여 중이에요.`
        : '입장에 실패했어요. 다시 시도해주세요.';
      cleanupLocalStream();
      currentRoom = null;
      return;
    }

    if (res.resumeToken) resumeToken = res.resumeToken;

    if (res.waiting) {
      // Room has approval turned on and someone else is already hosting —
      // sit on the waiting screen until the host admits or denies us.
      joinScreen.classList.add('hidden');
      waitingScreen.classList.remove('hidden');
      return;
    }

    isHost = !!res.isHost;
    enterCallScreen(res.peers, res.sharingPeerId, res.whiteboard);
  });
}

async function enterCallScreen(peers, sharingPeerId, whiteboard) {
  joinScreen.classList.add('hidden');
  waitingScreen.classList.add('hidden');
  callScreen.classList.remove('hidden');
  enteredCall = true;
  roomLabel.textContent = `수업 코드: ${currentRoom}`;

  activeScreenShareId = sharingPeerId || null;

  if (!whiteboardOnlyMode) {
    addVideoTile('local', 'local', `${myName} (나)`, localStream, true);

    // 오디오 설정·진단 모듈 연결
    if (window.AudioControls) {
      AudioControls.setLocalStream(localStream);
      if (!audioControlsReady) {
        AudioControls.init({
          localStream,
          getPeerConnections: () => Array.from(peerConnections.values()),
          showButton: true,
          // 마이크를 교체하면 새 트랙에도 현재 음소거 상태를 그대로 반영한다.
          onMicChange: (track) => { track.enabled = micOn; },
        });
        audioControlsReady = true;
      }
      AudioControls.showButton();
    }
  }
  updateParticipantCount();

  pendingBtn.classList.toggle('hidden', !isHost);
  if (!isHost) {
    pendingPanel.classList.add('hidden');
    pendingList = [];
  }

  // Connect out to everyone already in the room (whiteboard device skips this).
  // Make sure TURN creds are loaded first, otherwise the first offers go out
  // STUN-only and may fail to connect on restrictive mobile networks.
  if (!whiteboardOnlyMode && peers && peers.length) {
    await ensureIceServers();
    peers.forEach((peer) => {
      peerNames.set(peer.id, peer.name);
      createPeerConnection(peer.id, true);
    });
  }
  // 입장 시 내 마이크 상태를 방에 한 번 알려, 기존 참가자 타일에 바로 반영되게 한다.
  if (!whiteboardOnlyMode) socket.emit('mic-state', { on: micOn });

  // Sync the shared whiteboard: replay existing strokes, and open it if it
  // was already active when we joined.
  if (whiteboard) applyWhiteboardSnapshot(whiteboard);

  // 원격 낭독이 들리도록 '소리 켜기' 안내를 띄운다(음성합성이 이미 깨어 있으면 생략).
  showSoundBanner();
}

// ---- Approval chime (host) ---------------------------------------------
// Browsers keep an AudioContext SUSPENDED until a user gesture (autoplay policy),
// so we create it lazily and resume() it on the first click/tap/keypress. Without
// this unlock, oscillator.start() runs but plays silence — which is exactly why
// the "입장 승인 알림음" was inaudible.
let chimeEnabled = true;   // set false to mute; wire a button to this if you like
let _audioCtx = null;
function ensureAudioContext() {
  try {
    if (!_audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      _audioCtx = new AC();
    }
    if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
    return _audioCtx;
  } catch (e) { return null; }
}
function _unlockAudioOnce() {
  ensureAudioContext();
  ['click', 'touchend', 'keydown'].forEach((ev) => window.removeEventListener(ev, _unlockAudioOnce));
}
['click', 'touchend', 'keydown'].forEach((ev) =>
  window.addEventListener(ev, _unlockAudioOnce, { passive: true }));

function playApprovalChime() {
  if (!chimeEnabled) return;
  const ctx = ensureAudioContext();
  if (!ctx) return;
  const now = ctx.currentTime;
  // Gentle two-tone (A5 → D6).
  [[880, 0], [1174.66, 0.14]].forEach(([freq, offset]) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const t = now + offset;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.3);
  });
}

function flashPendingBtn() {
  if (!pendingBtn) return;
  pendingBtn.classList.add('pending-alert');
  setTimeout(() => pendingBtn.classList.remove('pending-alert'), 1600);
}

// Host receives this whenever the pending queue changes. Chime + flash only when
// a genuinely NEW person appears (not when someone is removed/admitted).
let _prevPendingIds = new Set();
socket.on('pending-list', (list) => {
  pendingList = list || [];
  const ids = new Set(pendingList.map((p) => p.id));
  let hasNew = false;
  ids.forEach((id) => { if (!_prevPendingIds.has(id)) hasNew = true; });
  _prevPendingIds = ids;
  if (hasNew && isHost) {
    playApprovalChime();
    flashPendingBtn();
  }
  renderPendingPanel();
});

function renderPendingPanel() {
  pendingCount.textContent = String(pendingList.length);
  pendingPanel.innerHTML = '';

  if (pendingList.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'pending-item';
    empty.style.borderBottom = 'none';
    empty.style.color = 'var(--muted)';
    empty.textContent = '대기 중인 참가자가 없습니다.';
    pendingPanel.appendChild(empty);
    return;
  }

  pendingList.forEach((p) => {
    const item = document.createElement('div');
    item.className = 'pending-item';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = p.name;

    const actions = document.createElement('div');
    actions.className = 'actions';

    const admitBtn = document.createElement('button');
    admitBtn.className = 'admit-btn';
    admitBtn.textContent = '승인';
    admitBtn.addEventListener('click', () => {
      socket.emit('admission-response', { targetId: p.id, approve: true });
    });

    const denyBtn = document.createElement('button');
    denyBtn.className = 'deny-btn';
    denyBtn.textContent = '거절';
    denyBtn.addEventListener('click', () => {
      socket.emit('admission-response', { targetId: p.id, approve: false });
    });

    actions.appendChild(admitBtn);
    actions.appendChild(denyBtn);
    item.appendChild(nameSpan);
    item.appendChild(actions);
    pendingPanel.appendChild(item);
  });
}

pendingBtn.addEventListener('click', () => {
  pendingPanel.classList.toggle('hidden');
});

// Waiting student: the host made a decision.
socket.on('admission-result', ({ approved, peers, maxSize, reason, sharingPeerId, whiteboard, resumeToken: rt }) => {
  if (approved) {
    if (rt) resumeToken = rt;
    isHost = false;
    // Tell the server (from our own socket) to finalize our room membership
    // BEFORE we start creating peer connections — otherwise our WebRTC
    // signals would be dropped and we'd never actually connect.
    let entered = false;
    const enterOnce = () => {
      if (entered) return;
      entered = true;
      enterCallScreen(peers, sharingPeerId, whiteboard);
    };
    socket.emit('confirm-admission', { roomId: currentRoom }, enterOnce);
    // Fallback: if the ack doesn't come back promptly, enter anyway.
    setTimeout(enterOnce, 1500);
    return;
  }

  waitingScreen.classList.add('hidden');
  joinScreen.classList.remove('hidden');
  joinError.textContent = reason === 'room-full'
    ? `이 수업 코드는 이미 ${maxSize}명이 참여 중이에요.`
    : '선생님이 입장 요청을 거절했어요.';
  cleanupLocalStream();
  currentRoom = null;
});

cancelWaitBtn.addEventListener('click', () => {
  socket.emit('cancel-wait');
  waitingScreen.classList.add('hidden');
  joinScreen.classList.remove('hidden');
  cleanupLocalStream();
  currentRoom = null;
  enteredCall = false;
  lastJoin = null;
});

// ---- Auto-recovery on socket reconnect ---------------------------------
// A brief network drop (phone locks, wifi↔LTE handoff, tunnel) makes Socket.io
// silently reconnect with a NEW id. Without this, the reconnected socket is in
// no room and the video just freezes until the student reloads and re-enters.
// Here we detect the reconnect, tear down the dead peer connections, and re-join
// the SAME room using the resume token so the teacher doesn't re-approve anyone.
function showReconnecting(on) {
  let el = document.getElementById('reconnecting-banner');
  if (on) {
    if (!el) {
      el = document.createElement('div');
      el.id = 'reconnecting-banner';
      el.textContent = '네트워크 재연결 중…';
      el.style.cssText =
        'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9999;' +
        'background:rgba(20,20,20,.88);color:#fff;padding:8px 16px;border-radius:999px;' +
        'font-size:14px;font-weight:600;box-shadow:0 2px 10px rgba(0,0,0,.3);';
      document.body.appendChild(el);
    }
  } else if (el) {
    el.remove();
  }
}

function rejoinAfterReconnect() {
  if (!enteredCall || !lastJoin) return;

  // The old peer connections point at our previous socket id and are dead now.
  peerConnections.forEach((pc, id) => { try { pc.close(); } catch (e) {} removeVideoTile(id); });
  peerConnections.clear();

  showReconnecting(true);
  socket.emit('join-room', { ...lastJoin, resumeToken }, (res) => {
    if (!res || !res.ok) {
      // Couldn't get back in (room gone, full, etc.). Leave the banner briefly,
      // then send them back to the join screen to try manually.
      showReconnecting(false);
      return;
    }
    if (res.resumeToken) resumeToken = res.resumeToken;

    // Rare: resume token expired AND approval is on → we're back in the queue.
    if (res.waiting) {
      showReconnecting(false);
      callScreen.classList.add('hidden');
      waitingScreen.classList.remove('hidden');
      return;
    }

    isHost = !!res.isHost;
    // 재접속: 새 피어를 만들기 전에 가상배경을 다시 세운다. 재접속 중 vbgStream이
    // 끊겼을 수 있는데, setBackground가 끊긴 파이프라인을 감지해 재구축하므로,
    // 이어서 만들어지는 피어들에는 살아 있는 배경 트랙이 실려 나간다.
    if (currentBgMode !== 'none') setBackground(currentBgMode);
    enterCallScreen(res.peers || [], res.sharingPeerId, res.whiteboard);
    // enterCallScreen이 로컬 타일을 생카메라로 다시 그리므로, 배경이 켜져 있으면
    // 나가는 트랙과 로컬 자기화면을 배경으로 다시 맞춘다.
    if (currentBgMode !== 'none') { applyOutgoingVideoToAllPeers(); updateLocalPreview(); }
    showReconnecting(false);
  });
}

socket.on('connect', () => {
  if (firstConnect) { firstConnect = false; return; }
  rejoinAfterReconnect();
});

socket.on('disconnect', () => {
  if (enteredCall) showReconnecting(true);
});

socket.on('peer-joined', ({ id, name }) => {
  peerNames.set(id, name);
  // Existing members wait for the new peer's offer; the pc is created
  // lazily in the 'signal' handler when that offer arrives.
  updateParticipantCount();
  // 새 참가자가 내 현재 마이크 상태를 알 수 있도록 다시 알린다.
  socket.emit('mic-state', { on: micOn });
  // 듣기시험 중에 새로 들어온 학생 화면도 가리도록 상태를 다시 알린다(호스트만).
  if (isHost && wbListening) socket.emit('listening-mode', { on: true });
});

// 다른 참가자의 마이크 on/off 상태 → 해당 타일에 반영.
socket.on('peer-mic-state', ({ id, on }) => {
  setTileMic(id, !!on);
});

// 공유 읽기: 누군가 '읽기'를 누르면 모두의 기기에서 같은 영어 텍스트를 재생.
socket.on('wb-read', ({ action, text, rate } = {}) => {
  if (!wbTTS) return;
  if (action === 'stop') { wbStopReading(); return; }
  if (action === 'play' && text) {
    wbReadOwner = false;  // 나는 수신자(정지 방송 안 함)
    wbPrimeTTS();
    wbSpeakText(text, rate);
  }
});

socket.on('peer-left', ({ id }) => {
  if (window.AudioControls) AudioControls.detachRemote(id);
  const pc = peerConnections.get(id);
  if (pc) { if (pc._connPoll) clearInterval(pc._connPoll); pc.close(); }
  peerConnections.delete(id);
  peerNames.delete(id);
  removeVideoTile(id);
  updateParticipantCount();
  if (activeScreenShareId === id) {
    activeScreenShareId = null;
    updateGridLayout();
  }
});

// Another participant started or stopped screen sharing.
socket.on('screen-share-status', ({ id, sharing }) => {
  if (sharing) {
    activeScreenShareId = id;
  } else if (activeScreenShareId === id) {
    activeScreenShareId = null;
  }
  updateGridLayout();
});

socket.on('signal', async ({ from, data }) => {
  if (whiteboardOnlyMode) return; // drawing tablet does no WebRTC
  let pc = peerConnections.get(from);

  if (data.type === 'offer') {
    if (!pc) pc = createPeerConnection(from, false);
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('signal', { to: from, data: { type: 'answer', sdp: answer } });
  } else if (data.type === 'answer') {
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
  } else if (data.type === 'candidate') {
    if (pc && data.candidate) {
      try { await pc.addIceCandidate(data.candidate); } catch (e) { /* benign race */ }
    }
  }
});

function createPeerConnection(peerId, isInitiator) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pc._isInitiator = !!isInitiator;
  pc._iceRestartTries = 0;
  peerConnections.set(peerId, pc);

  // Mic always comes from the camera stream. Video comes from whichever
  // source is currently active — camera, virtual background canvas, or
  // screen share (so peers who join mid-share/mid-background immediately
  // see the right thing).
  localStream.getAudioTracks().forEach((track) => pc.addTrack(track, localStream));
  const activeVideoTrack = getOutgoingVideoTrack();
  if (activeVideoTrack) pc.addTrack(activeVideoTrack, localStream);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', { to: peerId, data: { type: 'candidate', candidate: event.candidate } });
    }
  };

  pc.ontrack = (event) => {
    const label = peerNames.get(peerId) || '참여자';
    addVideoTile(peerId, 'remote', label, event.streams[0], false);
    // 상대방 타일에 마이크(발화) 표시를 붙인다. ontrack은 오디오·비디오
    // 트랙마다 발생하고 그때마다 타일이 새로 만들어지므로, 매번 새 타일에
    // 다시 부착한다(attachRemote가 이전 것을 알아서 정리).
    const tileEl = document.getElementById(`tile-${peerId}`);
    if (window.AudioControls && tileEl) {
      AudioControls.attachRemote(peerId, event.streams[0], tileEl);
    }
  };

  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    setTileConn(peerId,
      (st === 'connected' || st === 'completed') ? 'good'
      : (st === 'failed' || st === 'closed') ? 'bad'
      : 'weak');
    setTileReconnecting(peerId, st === 'disconnected' || st === 'failed');
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      // Leave the tile for now; peer-left will clean it up if they actually left.
    }
  };
  startConnQualityPoll(pc, peerId);

  // If the media path dies but the socket stays up (common on wifi↔LTE handoff),
  // renegotiate ICE instead of dropping the peer. Only the initiator side kicks
  // off the restart; the resulting offer flows through the normal signal relay.
  pc.oniceconnectionstatechange = () => {
    const st = pc.iceConnectionState;
    setTileReconnecting(peerId, st === 'disconnected' || st === 'failed');
    if (st === 'connected' || st === 'completed') setTileConn(peerId, 'good');
    if (st === 'failed' || st === 'disconnected') {
      if (pc._isInitiator && pc._iceRestartTries < 2 && typeof pc.restartIce === 'function') {
        pc._iceRestartTries += 1;
        // Small delay lets a transient 'disconnected' recover on its own first.
        setTimeout(() => {
          if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
            try { pc.restartIce(); } catch (e) { /* older browsers: rely on socket rejoin */ }
          }
        }, st === 'disconnected' ? 2500 : 0);
      }
    } else if (st === 'connected' || st === 'completed') {
      pc._iceRestartTries = 0;
    }
  };

  if (isInitiator) {
    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('signal', { to: peerId, data: { type: 'offer', sdp: offer } });
      } catch (e) { console.error('negotiation error', e); }
    };
  }

  return pc;
}

// ---- Video grid ----------------------------------------------------------
function addVideoTile(id, kind, label, stream, muted) {
  removeVideoTile(id);
  const tile = document.createElement('div');
  tile.className = `tile ${kind === 'local' ? 'local' : ''}`;
  tile.id = `tile-${id}`;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = muted;
  video.srcObject = stream;

  const labelEl = document.createElement('div');
  labelEl.className = 'tile-label';
  labelEl.textContent = label;

  // 우상단 상태 표시: 연결(와이파이) 점 + 마이크 아이콘.
  const status = document.createElement('div');
  status.className = 'tile-status';
  const conn = document.createElement('span');
  conn.className = 'tile-conn';
  const micEl = document.createElement('span');
  micEl.className = 'tile-mic';
  micEl.textContent = '🎤';
  status.appendChild(conn);
  status.appendChild(micEl);

  // 개별 참여자 재연결 중 표시(피어 미디어 끊김 시 노출).
  const reconn = document.createElement('div');
  reconn.className = 'tile-reconnecting hidden';
  reconn.textContent = '🔄 재연결 중…';

  tile.appendChild(video);
  tile.appendChild(labelEl);
  tile.appendChild(status);
  tile.appendChild(reconn);
  videoGrid.appendChild(tile);
  updateGridLayout();

  // 초기 상태.
  if (kind === 'local') {
    setTileConn('local', socket.connected ? 'good' : 'bad');
    setTileMic('local', micOn);
  } else {
    setTileConn(id, 'weak');   // 연결 수립 중 → 노랑
    setTileMic(id, true);      // 원격 마이크는 상대의 mic-state 신호로 갱신(기본 켜짐)
  }
}

// 타일의 연결 상태 점을 갱신. level: 'good' | 'weak' | 'bad'
function setTileConn(id, level) {
  const tile = document.getElementById(`tile-${id}`);
  const el = tile && tile.querySelector('.tile-conn');
  if (!el) return;
  el.classList.remove('good', 'weak', 'bad');
  el.classList.add(level);
  el.title = level === 'good' ? '연결 양호' : level === 'weak' ? '연결 불안정' : '연결 끊김';
  tile.classList.toggle('conn-bad', level === 'bad'); // 끊김 시 영상 어둡게 강조
}
// 타일의 마이크 아이콘을 갱신. on=true면 켜짐(🎤), false면 꺼짐(🔇).
function setTileMic(id, on) {
  const tile = document.getElementById(`tile-${id}`);
  const el = tile && tile.querySelector('.tile-mic');
  if (!el) return;
  el.textContent = on ? '🎤' : '🔇';
  el.classList.toggle('off', !on);
  el.title = on ? '마이크 켜짐' : '마이크 꺼짐';
  tile.classList.toggle('mic-off', !on); // 꺼짐 시 붉은 테두리 강조
}
// 타일에 '재연결 중…'을 보이거나 숨긴다.
function setTileReconnecting(id, on) {
  const tile = document.getElementById(`tile-${id}`);
  const el = tile && tile.querySelector('.tile-reconnecting');
  if (!el) return;
  el.classList.toggle('hidden', !on);
}

// 연결이 붙은 뒤에도 패킷 손실/왕복지연을 주기적으로 재서 와이파이 상태를 근사한다.
// (연결은 됐지만 회선이 나쁘면 초록 → 노랑/빨강으로 낮춘다.)
function startConnQualityPoll(pc, peerId) {
  let lastLost = 0, lastTotal = 0;
  const timer = setInterval(async () => {
    if (!peerConnections.has(peerId) || pc.connectionState === 'closed') {
      clearInterval(timer);
      return;
    }
    if (pc.connectionState !== 'connected' && pc.connectionState !== 'completed') return;
    try {
      const stats = await pc.getStats();
      let lost = 0, recv = 0, rtt = 0;
      stats.forEach((r) => {
        if (r.type === 'inbound-rtp') {
          lost += r.packetsLost || 0;
          recv += r.packetsReceived || 0;
        }
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null) {
          rtt = r.currentRoundTripTime; // 초 단위
        }
      });
      const dLost = lost - lastLost;
      const dTotal = (recv + lost) - lastTotal;
      lastLost = lost; lastTotal = recv + lost;
      const lossRate = dTotal > 0 ? dLost / dTotal : 0;
      let level = 'good';
      if (lossRate > 0.08 || rtt > 0.4) level = 'bad';
      else if (lossRate > 0.03 || rtt > 0.2) level = 'weak';
      setTileConn(peerId, level);
    } catch (_) { /* getStats 미지원/실패는 무시 */ }
  }, 3000);
  pc._connPoll = timer;
}

function removeVideoTile(id) {
  const el = document.getElementById(`tile-${id}`);
  if (el) el.remove();
  updateGridLayout();
}

// ---- Spotlight layout: make the screen-sharer's tile big, shrink the rest
// into a horizontal thumbnail strip underneath. Works for local or any
// remote peer's tile — whichever one is currently sharing.
function updateGridLayout() {
  let thumbRow = document.getElementById('thumb-row');
  let resizeHandle = document.getElementById('spotlight-resize-handle');
  let layoutToggle = document.getElementById('spotlight-layout-toggle');

  if (!activeScreenShareId) {
    videoGrid.classList.remove('spotlight-mode', 'thumb-right', 'thumb-top');
    if (thumbRow) {
      Array.from(thumbRow.children).forEach((child) => videoGrid.appendChild(child));
      thumbRow.remove();
    }
    if (resizeHandle) resizeHandle.remove();
    if (layoutToggle) layoutToggle.remove();
    videoGrid.querySelectorAll('.tile').forEach((el) => el.classList.remove('featured', 'thumb'));
    videoGrid.style.removeProperty('--thumb-size');
    return;
  }

  videoGrid.classList.add('spotlight-mode');
  videoGrid.classList.toggle('thumb-right', thumbPosition === 'right');
  videoGrid.classList.toggle('thumb-top', thumbPosition === 'top');

  if (!thumbRow) {
    thumbRow = document.createElement('div');
    thumbRow.id = 'thumb-row';
    thumbRow.className = 'thumb-row';
    videoGrid.appendChild(thumbRow);
  }

  if (!resizeHandle) {
    resizeHandle = document.createElement('div');
    resizeHandle.id = 'spotlight-resize-handle';
    resizeHandle.className = 'resize-handle';
    resizeHandle.title = '드래그해서 크기 조절';
    attachResizeHandlers(resizeHandle);
    videoGrid.appendChild(resizeHandle);
  }

  if (!layoutToggle) {
    layoutToggle = buildLayoutToggle();
    videoGrid.appendChild(layoutToggle);
  }
  updateLayoutToggleUI(layoutToggle);
  applyThumbSizeVar();

  // Enforce DOM order: featured tile, then the handle, then the thumb
  // strip — regardless of the order these elements were first created in.
  videoGrid.insertBefore(resizeHandle, thumbRow);

  const featuredTileId = activeScreenShareId === 'local' ? 'tile-local' : `tile-${activeScreenShareId}`;

  videoGrid.querySelectorAll('.tile').forEach((tile) => {
    if (tile.id === featuredTileId) {
      tile.classList.add('featured');
      tile.classList.remove('thumb');
      videoGrid.insertBefore(tile, resizeHandle);
    } else {
      tile.classList.remove('featured');
      tile.classList.add('thumb');
      thumbRow.appendChild(tile);
    }
  });
}

// ---- Bottom/right toggle for the thumbnail strip -------------------------
function buildLayoutToggle() {
  const wrap = document.createElement('div');
  wrap.id = 'spotlight-layout-toggle';
  wrap.className = 'spotlight-layout-toggle';

  const topBtn = document.createElement('button');
  topBtn.type = 'button';
  topBtn.dataset.pos = 'top';
  topBtn.textContent = '⬆ 상단';

  const bottomBtn = document.createElement('button');
  bottomBtn.type = 'button';
  bottomBtn.dataset.pos = 'bottom';
  bottomBtn.textContent = '⬇ 아래';

  const rightBtn = document.createElement('button');
  rightBtn.type = 'button';
  rightBtn.dataset.pos = 'right';
  rightBtn.textContent = '➡ 오른쪽';

  [topBtn, bottomBtn, rightBtn].forEach((btn) => {
    btn.addEventListener('click', () => {
      if (thumbPosition === btn.dataset.pos) return;
      thumbPosition = btn.dataset.pos;
      saveLayoutPrefs();
      updateGridLayout();
    });
  });

  wrap.appendChild(topBtn);
  wrap.appendChild(bottomBtn);
  wrap.appendChild(rightBtn);
  return wrap;
}

function updateLayoutToggleUI(wrap) {
  wrap.querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.pos === thumbPosition);
  });
}

function applyThumbSizeVar() {
  const size = thumbPosition === 'right' ? thumbRightSize : thumbBottomSize;
  videoGrid.style.setProperty('--thumb-size', `${size}px`);
}

// ---- Drag-to-resize between the featured tile and the thumbnail strip ----
function attachResizeHandlers(handle) {
  let dragging = false;
  let startPos = 0;
  let startSize = 0;

  function eventPoint(e) {
    return e.touches && e.touches[0] ? e.touches[0] : e;
  }

  function pointerDown(e) {
    dragging = true;
    handle.classList.add('dragging');
    const point = eventPoint(e);
    startPos = thumbPosition === 'right' ? point.clientX : point.clientY;
    startSize = thumbPosition === 'right' ? thumbRightSize : thumbBottomSize;
    document.addEventListener('mousemove', pointerMove);
    document.addEventListener('mouseup', pointerUp);
    document.addEventListener('touchmove', pointerMove, { passive: false });
    document.addEventListener('touchend', pointerUp);
    e.preventDefault();
  }

  function pointerMove(e) {
    if (!dragging) return;
    const point = eventPoint(e);
    const current = thumbPosition === 'right' ? point.clientX : point.clientY;
    // Dragging the handle toward the featured tile grows the thumbnail
    // strip (moving up grows the bottom strip; moving left grows the
    // right strip), dragging the other way shrinks it.
    let delta = startPos - current;
    // When the strip is on top, the handle sits below it, so dragging DOWN
    // (not up) should grow the strip — flip the sign.
    if (thumbPosition === 'top') delta = -delta;
    if (thumbPosition === 'right') {
      thumbRightSize = clamp(startSize + delta, 140, 480);
    } else {
      thumbBottomSize = clamp(startSize + delta, 90, 360);
    }
    applyThumbSizeVar();
    e.preventDefault();
  }

  function pointerUp() {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.removeEventListener('mousemove', pointerMove);
    document.removeEventListener('mouseup', pointerUp);
    document.removeEventListener('touchmove', pointerMove);
    document.removeEventListener('touchend', pointerUp);
    saveLayoutPrefs();
  }

  handle.addEventListener('mousedown', pointerDown);
  handle.addEventListener('touchstart', pointerDown, { passive: false });
}

function updateParticipantCount() {
  participantCount.textContent = `참여자 ${peerConnections.size + 1}명`;
}

// ---- Controls --------------------------------------------------------
let micOn = true;
let camOn = true;

micBtn.addEventListener('click', () => {
  if (!localStream) return;
  micOn = !micOn;
  localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
  micBtn.textContent = micOn ? '마이크 끄기' : '마이크 켜기';
  micBtn.classList.toggle('active', !micOn);
  setTileMic('local', micOn);
  socket.emit('mic-state', { on: micOn }); // 다른 참가자 타일에 반영
});

camBtn.addEventListener('click', () => {
  if (!localStream) return;
  camOn = !camOn;
  localStream.getVideoTracks().forEach((t) => (t.enabled = camOn));
  camBtn.textContent = camOn ? '카메라 끄기' : '카메라 켜기';
  camBtn.classList.toggle('active', !camOn);
});

// ---- Outgoing video source resolver -------------------------------------
// Three possible sources, in priority order: screen share > virtual
// background canvas > raw camera. Screen share and virtual background are
// mutually exclusive (compositing both isn't useful — the background
// feature is for how *you* look, not for the shared screen).
function getOutgoingVideoTrack() {
  if (sharingScreen && screenStream) return screenStream.getVideoTracks()[0];
  if (currentBgMode !== 'none' && vbgStream) return vbgStream.getVideoTracks()[0];
  return localStream ? localStream.getVideoTracks()[0] : null;
}

function applyOutgoingVideoToAllPeers() {
  const track = getOutgoingVideoTrack();
  if (!track) return;
  peerConnections.forEach((pc) => {
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender) sender.replaceTrack(track);
  });
}

// Local self-view tile follows the same priority. Only the raw camera
// view gets mirrored (selfie-style) — screen share and the virtual
// background canvas are already drawn "normal" and shouldn't be flipped
// again, or shared text ends up backwards.
function updateLocalPreview() {
  const localTile = document.getElementById('tile-local');
  const localVideoEl = localTile?.querySelector('video');
  if (!localVideoEl) return;

  let stream;
  let mirror;
  if (sharingScreen && screenStream) {
    stream = screenStream; mirror = false;
  } else if (currentBgMode !== 'none' && vbgStream) {
    stream = vbgStream; mirror = false;
  } else {
    stream = localStream; mirror = true;
  }
  if (localVideoEl.srcObject !== stream) localVideoEl.srcObject = stream;
  localTile?.classList.toggle('local', mirror);
}

// 화면 공유는 데스크톱 브라우저에서만 지원된다 (모바일 크롬/사파리 미지원).
// 학생은 대부분 스마트폰이므로, 지원되지 않는 기기에서는 버튼을 숨겨 혼란을 없앤다.
const screenShareSupported =
  !!(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function');
if (!screenShareSupported && screenBtn) {
  screenBtn.style.display = 'none';
}

screenBtn.addEventListener('click', () => {
  if (sharingScreen) stopScreenShare(); else startScreenShare();
});

async function startScreenShare() {
  if (!screenShareSupported) {
    triggerToastIfAvailable('화면 공유는 PC(데스크톱) 브라우저에서만 가능합니다.');
    return;
  }
  try {
    // 필기(굿노트/PDF) 공유에 최적화: 프레임레이트를 낮추면 인코더가 남는
    // 대역폭을 '움직임'이 아니라 '해상도·선명도'에 쓰기 때문에 글씨가 또렷해진다.
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 12, max: 15 },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
  } catch (err) {
    return; // user cancelled the "choose what to share" picker
  }

  // contentHint='detail'은 브라우저/WebRTC에게 "부드러운 움직임보다 세밀함이
  // 중요하다"고 알려준다 — 손글씨·텍스트 공유에 딱 맞는 설정.
  const shareTrack = screenStream.getVideoTracks()[0];
  if (shareTrack && 'contentHint' in shareTrack) {
    shareTrack.contentHint = 'detail';
  }

  sharingScreen = true;
  screenBtn.textContent = '화면 공유 중지';
  screenBtn.classList.add('active');

  applyOutgoingVideoToAllPeers();
  updateLocalPreview();

  activeScreenShareId = 'local';
  updateGridLayout();
  socket.emit('screen-share', { sharing: true });

  // If sharing is stopped via the browser's own "Stop sharing" control
  // (not our button), revert automatically.
  if (shareTrack) shareTrack.onended = () => stopScreenShare();
}

function stopScreenShare() {
  if (!sharingScreen) return;
  sharingScreen = false;
  screenBtn.textContent = '화면 공유';
  screenBtn.classList.remove('active');

  if (screenStream) {
    screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
  }

  // Falls back to virtual background (if one's active) or plain camera.
  applyOutgoingVideoToAllPeers();
  updateLocalPreview();

  if (activeScreenShareId === 'local') {
    activeScreenShareId = null;
    updateGridLayout();
  }
  socket.emit('screen-share', { sharing: false });
}

// ======================= Shared multi-page whiteboard ====================
// The board is a list of PAGES. Each page is blank or shows one page of an
// uploaded PDF, and keeps its own pen strokes (so handwriting stays when you
// flip pages). The teacher uploads a PDF before class; each PDF page becomes a
// board. Page flips and strokes are synced to everyone over Socket.io in
// coordinates NORMALIZED to the page rectangle, so handwriting lands in the
// same spot on every screen size. PDFs render locally with PDF.js.

const wbCtx = wbCanvas ? wbCanvas.getContext('2d') : null;
const wbPdfCtx = wbPdfCanvas ? wbPdfCanvas.getContext('2d') : null;
let wbActive = false;
let wbTool = 'pen';
let wbColor = '#e5484d'; // 기본색: 빨강 (검정 스와치를 없앴으므로)
// 슬라이더 초기값과 항상 일치시켜, 처음 그릴 때부터 표시된 굵기 그대로 나오게 함.
let wbSize = wbSizeInput ? (Number(wbSizeInput.value) || 3) : 3;
let wbDrawing = false;
let wbCurrentId = null;
let wbPenSeen = false;
// 현재 획을 그리는 포인터의 id. 손바닥 등 다른 포인터의 up/cancel/leave가
// 애플펜슬 획을 끊지 못하게 하려고 추적한다.
let wbActivePointerId = null;
// 지금 화면에 닿아 있는 애플펜슬 포인터 id. 팜 리젝션은 "펜이 닿아 있는 동안의
// 손가락/손바닥 터치"만 무시하도록 하는 데 쓴다(영구 차단 X).
let wbPenDownId = null;
// 스파이크(바늘) 방지: iPadOS Safari의 getCoalescedEvents()가 가끔 (0,0)이나
// 엉뚱하게 멀리 떨어진 좌표를 돌려줘서 획에 바늘처럼 튀는 점이 끼어든다.
// 한 샘플에서 페이지의 이 비율(정규화 0..1)보다 크게 점프하면 사람 손이 아닌
// 이상치로 보고 버린다. 아주 빠른 철자도 샘플당 0.05 안쪽이라 넉넉한 값.
const WB_MAX_JUMP = 0.3;
const WB_MAX_JUMP_SQ = WB_MAX_JUMP * WB_MAX_JUMP;
let wbSpikesDropped = 0; // 진단용: ?wbdebug=1 화면에 표시
let wbSendBuffer = [];
let wbSendTimer = null;

// Shared view transform (synced to everyone): zoom factor + pan offset.
// panX/panY are fractions of the zoomed page size, so they stay consistent
// across different screen shapes. zoom=1, pan=0 means "fit the page" (original).
let wbZoom = 1;
let wbPanX = 0;
let wbPanY = 0;
let wbPanning = false;
let wbPanStart = null;
// 손가락 입력 모드: false=한 손가락으로 화면 이동(기본, 필기는 펜으로),
// true=한 손가락으로 그리기(펜 없는 기기용). 기기마다 다른 로컬 설정으로 저장한다.
let wbFingerDraw = false;
try { wbFingerDraw = localStorage.getItem('vc_wb_finger_draw') === '1'; } catch (_) {}
// 선택 읽기: 드래그로 사각형 영역을 선택해 그 안의 텍스트만 낭독.
let wbSelecting = false;
let wbSelStart = null;         // 선택 시작점(정규화 0..1)
let wbSelRect = null;          // 현재 선택 사각형 {x1,y1,x2,y2}(정규화)
// 두 손가락 핀치 줌/팬(아이패드) 상태.
const wbTouchPts = new Map(); // 활성 터치 포인터: id -> {x, y, t} (client CSS px, t=마지막 갱신 시각)
// iOS가 긴 세션 중 손가락 터치의 up/cancel 이벤트를 흘려버리면 wbTouchPts에
// '유령 손가락'이 남는다. 그러면 다음 한 손가락 터치가 유령과 합쳐져 두 손가락
// 핀치로 오인되고, 유령의 낡은 좌표로 계산돼 화면이 갑자기 튄다(특히 1시간쯤
// 지난 뒤). 일정 시간 갱신되지 않은(=떠 있는) 손가락을 새 터치 때마다 걷어낸다.
const WB_TOUCH_STALE_MS = 3000;
function wbPurgeStaleTouches(now) {
  wbTouchPts.forEach((p, id) => {
    if (now - ((p && p.t) || 0) > WB_TOUCH_STALE_MS) {
      wbTouchPts.delete(id);
      try { wbCanvas.releasePointerCapture(id); } catch (_) {}
      if (wbActivePointerId === id) {
        wbActivePointerId = null;
        wbPanning = false;
        wbPanStart = null;
      }
    }
  });
}
let wbPinch = null;           // 핀치 진행 중이면 { startDist, startZoom, nx, ny }
let wbViewSendTimer = null;

// Pages: [{ id, type:'blank'|'pdf', pdfId, pageIndex, aspect, strokes: Map }]
let wbPages = [{ id: 'pg-init', type: 'blank', aspect: 4 / 3, strokes: new Map() }];
let wbCurrentPage = 0;

// PDF.js document handles, keyed by pdfId, plus a per-page rendered-image cache.
const wbPdfDocs = new Map();        // pdfId -> PDFDocumentProxy
const wbPageImageCache = new Map(); // pageId -> HTMLCanvasElement (rendered PDF page)

function wbGenId() {
  return (socket.id || 'x').slice(0, 6) + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

function currentPageObj() {
  return wbPages[wbCurrentPage] || null;
}

// The rectangle (in canvas pixels) where the current page is drawn, letterboxed
// to the page's aspect ratio and centered. Strokes are normalized within this
// rect so they stay glued to the page/PDF regardless of screen shape.
function pageRect() {
  const pg = currentPageObj();
  const aspect = (pg && pg.aspect) ? pg.aspect : 4 / 3; // width/height
  const W = wbCanvas.width, H = wbCanvas.height;
  // Base "fit" rectangle (letterboxed to the page aspect).
  let w = W, h = W / aspect;
  if (h > H) { h = H; w = H * aspect; }
  // Apply the shared zoom, then the pan (clamped so the page can't be pushed
  // entirely off-screen). pan is a fraction of the zoomed page size.
  const zw = w * wbZoom, zh = h * wbZoom;
  const maxX = zw > W ? (zw - W) / 2 / zw : 0;
  const maxY = zh > H ? (zh - H) / 2 / zh : 0;
  const px = Math.min(maxX, Math.max(-maxX, wbPanX));
  const py = Math.min(maxY, Math.max(-maxY, wbPanY));
  return { x: (W - zw) / 2 + px * zw, y: (H - zh) / 2 + py * zh, w: zw, h: zh };
}

// Keep the stored pan within bounds for the current zoom/canvas (called after
// zoom changes and while dragging). Mirrors the clamp in pageRect().
function clampStoredPan() {
  if (!wbCanvas) return;
  const pg = currentPageObj();
  const aspect = (pg && pg.aspect) ? pg.aspect : 4 / 3;
  const W = wbCanvas.width, H = wbCanvas.height;
  let w = W, h = W / aspect;
  if (h > H) { h = H; w = H * aspect; }
  const zw = w * wbZoom, zh = h * wbZoom;
  const maxX = zw > W ? (zw - W) / 2 / zw : 0;
  const maxY = zh > H ? (zh - H) / 2 / zh : 0;
  wbPanX = Math.min(maxX, Math.max(-maxX, wbPanX));
  wbPanY = Math.min(maxY, Math.max(-maxY, wbPanY));
}

function updateZoomIndicator() {
  if (wbZoomIndicator) wbZoomIndicator.textContent = Math.round(wbZoom * 100) + '%';
}

// Apply the current view locally, and (optionally) tell everyone else.
function applyView(broadcast) {
  clampStoredPan();
  renderCurrentPage();
  updateZoomIndicator();
  if (broadcast) socket.emit('wb-view', { zoom: wbZoom, panX: wbPanX, panY: wbPanY });
}

function zoomBy(factor) {
  wbZoom = Math.min(4, Math.max(1, Math.round(wbZoom * factor * 100) / 100));
  if (wbZoom <= 1.001) { wbZoom = 1; wbPanX = 0; wbPanY = 0; }
  applyView(true);
}

// --- 두 손가락 핀치 줌/팬 (아이패드) ---------------------------------------
// client(CSS) 좌표 → 캔버스 내부 디바이스 픽셀. wbNormPoint과 같은 규약.
function wbClientToDevice(clientX, clientY) {
  const rect = wbCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return { x: (clientX - rect.left) * dpr, y: (clientY - rect.top) * dpr };
}
// 줌 1(맞춤)일 때의 페이지 크기(디바이스 px) — pageRect의 base와 동일.
function wbBaseFit() {
  const pg = currentPageObj();
  const aspect = (pg && pg.aspect) ? pg.aspect : 4 / 3;
  const W = wbCanvas.width, H = wbCanvas.height;
  let w = W, h = W / aspect;
  if (h > H) { h = H; w = H * aspect; }
  return { W, H, w, h };
}
function wbPinchDist() {
  const p = [...wbTouchPts.values()];
  if (p.length < 2) return 0;
  return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
}
function wbPinchMid() {
  const p = [...wbTouchPts.values()];
  return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
}
// 두 번째 손가락이 닿는 순간: 두 손가락 중점 아래의 페이지 좌표를 확대 기준점으로 기억.
function wbStartPinch() {
  const startDist = wbPinchDist();
  if (startDist <= 0) return;
  const m = wbPinchMid();
  const md = wbClientToDevice(m.x, m.y);
  const r = pageRect();
  wbPinch = { startDist, startZoom: wbZoom, nx: (md.x - r.x) / r.w, ny: (md.y - r.y) / r.h };
}
// 손가락이 움직일 때: 거리비로 줌을, 중점으로 팬을 갱신해 기준점을 손가락 사이에
// 붙들어 둔다(원하는 곳을 중심으로 자유 확대). 1(맞춤)~4배로 제한.
function wbUpdatePinch() {
  if (!wbPinch) return;
  const dist = wbPinchDist();
  if (dist <= 0) return;
  const { W, H, w, h } = wbBaseFit();
  let Z = wbPinch.startZoom * (dist / wbPinch.startDist);
  Z = Math.min(4, Math.max(1, Z));
  const zw = w * Z, zh = h * Z;
  const m = wbPinchMid();
  const md = wbClientToDevice(m.x, m.y);
  const rx = md.x - wbPinch.nx * zw;
  const ry = md.y - wbPinch.ny * zh;
  wbZoom = Math.round(Z * 1000) / 1000;
  wbPanX = zw > 0 ? (rx - (W - zw) / 2) / zw : 0;
  wbPanY = zh > 0 ? (ry - (H - zh) / 2) / zh : 0;
  applyView(false);      // 로컬 렌더 + 팬 클램프
  queueViewBroadcast();  // 원격에도 스로틀 전송
}

function sizeWhiteboardCanvas() {
  if (!wbCanvas || whiteboardPanel.classList.contains('hidden')) return;
  const wrap = wbCanvas.parentElement;
  const rect = wrap.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.max(1, Math.round(rect.width * dpr));
  const targetH = Math.max(1, Math.round(rect.height * dpr));
  let changed = false;
  [wbCanvas, wbPdfCanvas].forEach((c) => {
    if (c && (c.width !== targetW || c.height !== targetH)) {
      c.width = targetW; c.height = targetH; changed = true;
    }
  });
  if (changed) renderCurrentPage();
}

// Render the current page: PDF background (if any) + all its strokes.
function renderCurrentPage() {
  if (!wbCtx) return;
  wbCtx.clearRect(0, 0, wbCanvas.width, wbCanvas.height);
  if (wbPdfCtx) wbPdfCtx.clearRect(0, 0, wbPdfCanvas.width, wbPdfCanvas.height);

  const pg = currentPageObj();
  if (!pg) { updatePageIndicator(); return; }

  const r = pageRect();
  // White page background (so blank pages and PDF letterbox look like paper).
  if (wbPdfCtx) {
    wbPdfCtx.fillStyle = '#ffffff';
    wbPdfCtx.fillRect(r.x, r.y, r.w, r.h);
    const img = wbPageImageCache.get(pg.id);
    if (img) wbPdfCtx.drawImage(img, r.x, r.y, r.w, r.h);
  }

  // Draw all strokes for this page.
  pg.strokes.forEach((stroke) => drawStrokeSegment(stroke, 0));
  updatePageIndicator();

  // 선택 읽기 사각형 오버레이(획 위에 표시).
  if (wbSelRect) {
    const sx = r.x + wbSelRect.x1 * r.w;
    const sy = r.y + wbSelRect.y1 * r.h;
    const sw = (wbSelRect.x2 - wbSelRect.x1) * r.w;
    const sh = (wbSelRect.y2 - wbSelRect.y1) * r.h;
    wbCtx.save();
    wbCtx.globalCompositeOperation = 'source-over';
    wbCtx.globalAlpha = 1;
    wbCtx.fillStyle = 'rgba(47,111,237,0.20)';
    wbCtx.strokeStyle = 'rgba(47,111,237,0.95)';
    wbCtx.lineWidth = 2;
    wbCtx.fillRect(sx, sy, sw, sh);
    wbCtx.strokeRect(sx, sy, sw, sh);
    wbCtx.restore();
  }

  // If this is a PDF page we haven't rendered yet, kick off rendering.
  if (pg.type === 'pdf' && !wbPageImageCache.get(pg.id)) {
    ensurePdfPageRendered(pg);
  }
}

function drawStrokeSegment(stroke, fromIdx) {
  if (!wbCtx || stroke.points.length === 0) return;
  const r = pageRect();
  const toPx = (p) => ({ x: r.x + p.x * r.w, y: r.y + p.y * r.h });
  wbCtx.lineCap = 'round';
  wbCtx.lineJoin = 'round';
  wbCtx.globalAlpha = 1;
  if (stroke.erase) {
    wbCtx.globalCompositeOperation = 'destination-out';
    wbCtx.strokeStyle = 'rgba(0,0,0,1)';
  } else if (stroke.highlight) {
    // Highlighter: translucent colour so the text/PDF underneath shows through.
    // Highlight strokes are always redrawn as one full path (see renderCurrentPage
    // and the receive handlers), so the alpha stays uniform along the stroke
    // instead of darkening at each segment join.
    wbCtx.globalCompositeOperation = 'source-over';
    wbCtx.globalAlpha = 0.4;
    wbCtx.strokeStyle = stroke.color;
  } else {
    wbCtx.globalCompositeOperation = 'source-over';
    wbCtx.strokeStyle = stroke.color;
  }
  // Scale line width by the page height so it looks consistent across screens.
  wbCtx.lineWidth = stroke.width * (r.h / 800) * (window.devicePixelRatio || 1) + 0.4;

  const pts = stroke.points;
  if (fromIdx === 0 && pts.length === 1) {
    const p = toPx(pts[0]);
    wbCtx.beginPath();
    wbCtx.arc(p.x, p.y, wbCtx.lineWidth / 2, 0, Math.PI * 2);
    wbCtx.fillStyle = stroke.erase ? 'rgba(0,0,0,1)' : stroke.color;
    wbCtx.fill();
    wbCtx.globalCompositeOperation = 'source-over';
    wbCtx.globalAlpha = 1;
    return;
  }
  // 획을 직선(lineTo) 대신 '연속된 점들의 중점을 지나는 곡선(quadratic)'으로 그린다.
  // 불투명한 펜/지우개는 매 move마다 획 전체를 다시 그려도 같은 색이 겹쳐서 티가 안 나고,
  // 그래서 실시간 필기도 각지지 않고 매끄럽게 이어진다. (형광펜은 renderCurrentPage에서
  // 한 획으로 전체 렌더되므로 투명도가 균일하게 유지된다.) fromIdx는 호환용으로 남겨둔다.
  const pts2 = pts.map(toPx);
  wbCtx.beginPath();
  wbCtx.moveTo(pts2[0].x, pts2[0].y);
  if (pts2.length === 2) {
    wbCtx.lineTo(pts2[1].x, pts2[1].y);
  } else {
    for (let i = 1; i < pts2.length - 1; i++) {
      const mx = (pts2[i].x + pts2[i + 1].x) / 2;
      const my = (pts2[i].y + pts2[i + 1].y) / 2;
      wbCtx.quadraticCurveTo(pts2[i].x, pts2[i].y, mx, my);
    }
    const penult = pts2[pts2.length - 2];
    const lastp = pts2[pts2.length - 1];
    wbCtx.quadraticCurveTo(penult.x, penult.y, lastp.x, lastp.y);
  }
  wbCtx.stroke();
  wbCtx.globalCompositeOperation = 'source-over';
  wbCtx.globalAlpha = 1;
}

// ---- PDF rendering (PDF.js) ----
async function loadPdfDoc(pdfId) {
  if (wbPdfDocs.has(pdfId)) return wbPdfDocs.get(pdfId);
  if (!window.pdfjsLib) throw new Error('pdfjs-not-ready');
  const url = `/room-pdf/${encodeURIComponent(currentRoom)}/${encodeURIComponent(pdfId)}`;
  const task = window.pdfjsLib.getDocument(url);
  const doc = await task.promise;
  wbPdfDocs.set(pdfId, doc);
  return doc;
}

async function ensurePdfPageRendered(pg) {
  if (!pg || pg.type !== 'pdf' || wbPageImageCache.get(pg.id)) return;
  try {
    if (wbLoading) wbLoading.classList.remove('hidden');
    const doc = await loadPdfDoc(pg.pdfId);
    const page = await doc.getPage(pg.pageIndex);
    // Render at a crisp scale for legibility.
    const baseViewport = page.getViewport({ scale: 1 });
    const targetWidth = 1400;
    const scale = targetWidth / baseViewport.width;
    const viewport = page.getViewport({ scale });
    const off = document.createElement('canvas');
    off.width = Math.round(viewport.width);
    off.height = Math.round(viewport.height);
    const offCtx = off.getContext('2d');
    await page.render({ canvasContext: offCtx, viewport }).promise;
    wbPageImageCache.set(pg.id, off);
    if (currentPageObj() && currentPageObj().id === pg.id) renderCurrentPage();
  } catch (e) {
    triggerToastIfAvailable('PDF 페이지를 불러오지 못했어요.');
  } finally {
    if (wbLoading) wbLoading.classList.add('hidden');
  }
}

// Read a PDF file locally to learn its page count + aspect ratios (so we can
// tell the server how many boards to create), and upload the bytes.
async function addPdfFile(file) {
  if (!window.pdfjsLib) {
    triggerToastIfAvailable('PDF 기능 로딩 중입니다. 잠시 후 다시 시도해주세요.');
    return;
  }
  try {
    if (wbLoading) wbLoading.classList.remove('hidden');
    const buf = await file.arrayBuffer();

    // Upload the bytes to the server first.
    const resp = await fetch(`/upload-pdf/${encodeURIComponent(currentRoom)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: buf,
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'upload-failed');
    const pdfId = data.pdfId;

    // Parse locally to get page count + per-page aspect ratios.
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
    wbPdfDocs.set(pdfId, doc);
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      pages.push({ pageIndex: i, aspect: vp.width / vp.height });
    }
    socket.emit('wb-add-pdf', { pdfId, pages });
  } catch (e) {
    triggerToastIfAvailable('PDF를 추가하지 못했어요. 파일을 확인해주세요.');
  } finally {
    if (wbLoading) wbLoading.classList.add('hidden');
  }
}

// ---- Local drawing input (Apple Pencil friendly) ----

// 진단용: 주소창 URL 뒤에 ?wbdebug=1 을 붙이면 화면 왼쪽 아래에 최근 포인터
// 이벤트(down/up/cancel + pen/touch)가 표시됩니다. 문제 재현 시 이 내용을 알려주면
// 원인을 정확히 짚을 수 있어요. 평소 수업에는 표시되지 않습니다.
const WB_DEBUG = (new URLSearchParams(location.search).get('wbdebug') === '1');
let wbDbgBox = null;
const wbDbgLog = [];
function wbDbg(e) {
  if (!WB_DEBUG || !e) return;
  const name = (e.type || '').replace('pointer', '');
  wbDbgLog.push(`${name} ${e.pointerType || '?'} #${e.pointerId}`);
  if (wbDbgLog.length > 12) wbDbgLog.shift();
  if (!wbDbgBox) {
    wbDbgBox = document.createElement('div');
    wbDbgBox.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:99999;'
      + 'background:rgba(0,0,0,.8);color:#0f0;font:11px/1.4 monospace;'
      + 'padding:6px 8px;border-radius:6px;pointer-events:none;white-space:pre;max-width:60vw;';
    document.body.appendChild(wbDbgBox);
  }
  wbDbgBox.textContent = wbDbgLog.join('\n') + `\n버린 스파이크: ${wbSpikesDropped}`;
}
// 진단용: 이벤트가 아닌 임의 메모(획별 점 개수 등)를 오버레이에 한 줄 남긴다.
let wbMoveCount = 0; // 현재 획에서 발생한 pointermove 이벤트 수(계측용)
function wbDbgNote(text) {
  if (!WB_DEBUG) return;
  wbDbgLog.push(text);
  if (wbDbgLog.length > 12) wbDbgLog.shift();
  if (wbDbgBox) wbDbgBox.textContent = wbDbgLog.join('\n') + `\n버린 스파이크: ${wbSpikesDropped}`;
}

function wbPointerDown(e) {
  wbDbg(e);
  if (!wbActive) return;
  const pg = currentPageObj();
  if (!pg) return;

  // 두 손가락 핀치 줌/팬. 펜이 "지금" 닿아 있으면(펜 필기 중) 관여하지 않는다.
  if (e.pointerType === 'touch' && wbPenDownId === null) {
    wbPurgeStaleTouches(performance.now());   // 유령 손가락 제거(핀치 오인·화면 튐 방지)
    wbTouchPts.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
    if (wbTouchPts.size >= 2) {
      if (wbTouchPts.size === 2) {
        // 두 번째 손가락 → 핀치 시작. 첫 손가락이 시작했을 수 있는 획/패닝을 취소.
        if (wbDrawing && wbCurrentId && pg.strokes.has(wbCurrentId)) {
          pg.strokes.delete(wbCurrentId);
          renderCurrentPage();
        }
        wbTouchPts.forEach((_, id) => { try { wbCanvas.releasePointerCapture(id); } catch (_) {} });
        wbDrawing = false;
        wbCurrentId = null;
        wbActivePointerId = null;
        wbPanning = false;
        wbPanStart = null;
        wbStartPinch();
      }
      e.preventDefault();
      return;
    }
    // 한 손가락: 그리지 않고 화면을 이동(팬)한다. 필기는 애플펜슬로만 되게 한다.
    // (선택읽기 도구일 때만 예외 — 손가락 드래그로 영역을 고르도록 아래로 넘긴다.)
    if (!wbFingerDraw && wbTool !== 'readselect') {
      wbPanning = true;
      wbPanStart = { x: e.clientX, y: e.clientY, panX: wbPanX, panY: wbPanY };
      wbActivePointerId = e.pointerId;
      try { wbCanvas.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
      return;
    }
  }

  // Pan tool: drag to move the (zoomed) page instead of drawing. Works with any
  // pointer type so a finger can pan even after the Apple Pencil has been used.
  if (wbTool === 'pan') {
    wbPanning = true;
    wbPanStart = { x: e.clientX, y: e.clientY, panX: wbPanX, panY: wbPanY };
    wbActivePointerId = e.pointerId;
    try { wbCanvas.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
    return;
  }

  // 선택 읽기 도구: 드래그로 영역을 선택한다(그리지 않음).
  if (wbTool === 'readselect') {
    const p = wbNormPoint(e);
    wbSelStart = p;
    wbSelRect = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    wbSelecting = true;
    wbActivePointerId = e.pointerId;
    try { wbCanvas.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
    return;
  }

  if (e.pointerType === 'pen') { wbPenSeen = true; wbPenDownId = e.pointerId; }
  // 팜 리젝션: 애플펜슬이 "지금" 닿아 있는 동안 들어오는 손가락/손바닥 터치만 무시.
  // (예전엔 펜을 한 번 쓰면 영구히 터치를 막아, 철자를 빠르게 쓸 때 다음 접촉이
  //  iOS에서 잠깐 touch로 보고되면 막혀버리는 문제가 있었음.)
  if (e.pointerType === 'touch' && wbPenDownId !== null) return;

  // 이미 다른 포인터로 그리는 중일 때(예: 손바닥이 펜보다 먼저 닿음):
  //  - 새로 들어온 게 펜이면 손바닥이 시작한 획을 버리고 펜으로 교체(펜 우선).
  //  - 새로 들어온 게 손가락/손바닥이면 무시.
  if (wbActivePointerId !== null && wbActivePointerId !== e.pointerId) {
    if (e.pointerType !== 'pen') return;
    if (wbCurrentId && pg.strokes.has(wbCurrentId)) {
      pg.strokes.delete(wbCurrentId);
      renderCurrentPage();
    }
    try { wbCanvas.releasePointerCapture(wbActivePointerId); } catch (_) {}
    wbPanning = false;   // 손가락 팬을 애플펜슬이 인계받을 때 팬 종료
    wbPanStart = null;
  }

  wbActivePointerId = e.pointerId;
  wbDrawing = true;
  wbCurrentId = wbGenId();
  const p = wbNormPoint(e);
  const isEraser = wbTool === 'eraser';
  const isHi = wbTool === 'highlight';
  const isPencil = wbTool === 'pencil';
  // 연필: 펜보다 가늘게(굵기의 절반) + 색을 연하게(흰색 쪽으로 50%) 섞어 흑연 느낌.
  // 색·굵기는 획마다 전송되므로 별도 프로토콜 변경 없이 모든 참가자·PDF에 그대로 반영됨.
  const strokeColor = isPencil ? wbLighten(wbColor, 0.5) : wbColor;
  const strokeWidth = isEraser ? Math.max(wbSize * 2.5, 12)
    : (isHi ? Math.max(wbSize * 2, 5)
    : (isPencil ? Math.max(wbSize * 0.5, 1) : wbSize));
  const stroke = {
    color: strokeColor,
    width: strokeWidth,
    erase: isEraser,
    highlight: isHi,
    points: [p],
  };
  pg.strokes.set(wbCurrentId, stroke);
  // Highlight strokes redraw the whole page so the translucent path stays uniform.
  if (isHi) renderCurrentPage(); else drawStrokeSegment(stroke, 0);
  wbQueueSend(p);
  wbMoveCount = 0; // 새 획 시작 → move 카운터 리셋
  try { wbCanvas.setPointerCapture(e.pointerId); }
  catch (err) { wbDbgNote('  \u26a0 setPointerCapture 실패'); }
  e.preventDefault();
}

function wbPointerMove(e) {
  // 핀치 중이면 확대/이동만 갱신하고 그리지 않는다.
  if (wbPinch && e.pointerType === 'touch' && wbTouchPts.has(e.pointerId)) {
    wbTouchPts.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
    wbUpdatePinch();
    e.preventDefault();
    return;
  }
  // Panning the zoomed page (dragging with the ✋ tool).
  if (wbPanning && wbPanStart) {
    if (e.pointerType === 'touch') { const tp = wbTouchPts.get(e.pointerId); if (tp) tp.t = performance.now(); }
    const dpr = window.devicePixelRatio || 1;
    const r = pageRect();
    wbPanX = wbPanStart.panX + (e.clientX - wbPanStart.x) * dpr / r.w;
    wbPanY = wbPanStart.panY + (e.clientY - wbPanStart.y) * dpr / r.h;
    clampStoredPan();
    renderCurrentPage();
    queueViewBroadcast();
    e.preventDefault();
    return;
  }
  // 선택 읽기: 사각형을 갱신하고 오버레이를 다시 그린다.
  if (wbSelecting && wbSelStart) {
    if (wbActivePointerId !== null && e.pointerId !== wbActivePointerId) return;
    const p = wbNormPoint(e);
    wbSelRect = {
      x1: Math.min(wbSelStart.x, p.x), y1: Math.min(wbSelStart.y, p.y),
      x2: Math.max(wbSelStart.x, p.x), y2: Math.max(wbSelStart.y, p.y),
    };
    renderCurrentPage();
    e.preventDefault();
    return;
  }
  if (!wbDrawing || !wbCurrentId) return;
  if (wbActivePointerId !== null && e.pointerId !== wbActivePointerId) return;
  if (e.pointerType === 'touch' && wbPenDownId !== null && e.pointerId !== wbActivePointerId) return;
  const pg = currentPageObj();
  const stroke = pg && pg.strokes.get(wbCurrentId);
  if (!stroke) return;
  wbMoveCount++; // 계측: 이 획에 실제로 도달한 move 이벤트 수
  const events = (e.getCoalescedEvents && e.getCoalescedEvents().length)
    ? e.getCoalescedEvents() : [e];
  const fromIdx = stroke.points.length;
  events.forEach((ev) => {
    // iPadOS Safari 보간 이벤트가 가끔 (0,0) 쓰레기 좌표를 준다 → 버림.
    if (ev.clientX === 0 && ev.clientY === 0) { wbSpikesDropped++; return; }
    const p = wbNormPoint(ev);
    // 직전에 채택된 점에서 한 샘플에 너무 크게 튀면 이상치(스파이크)로 보고 버림.
    // 버린 점은 저장·전송 모두 안 하므로 원격 화면과 PDF 저장도 함께 깨끗해진다.
    const last = stroke.points[stroke.points.length - 1];
    if (last) {
      const dx = p.x - last.x, dy = p.y - last.y;
      if (dx * dx + dy * dy > WB_MAX_JUMP_SQ) { wbSpikesDropped++; return; }
    }
    stroke.points.push(p);
    wbQueueSend(p);
  });
  // Highlight strokes redraw the whole page so the translucent path stays uniform.
  if (stroke.highlight) renderCurrentPage(); else drawStrokeSegment(stroke, fromIdx);
  e.preventDefault();
}

function wbPointerUp(e) {
  wbDbg(e);
  // 핀치용 손가락 해제. 두 손가락 미만이 되면 핀치를 끝내고 최종 뷰를 공유한다.
  if (e && e.pointerType === 'touch' && wbTouchPts.has(e.pointerId)) {
    wbTouchPts.delete(e.pointerId);
    if (wbPinch) {
      if (wbTouchPts.size < 2) { wbPinch = null; applyView(true); }
      if (e.preventDefault) e.preventDefault();
      return; // 핀치 손가락의 up은 여기서 소비(그리기 종료 로직 안 탐)
    }
    // 핀치가 아니면(단일 손가락 그리기 등) 아래 정상 종료 로직을 그대로 탄다.
  }
  // 펜 접촉 해제 추적(팜 리젝션용)은 소유권 가드보다 먼저 처리해 상태가 갇히지 않게 함.
  if (e && e.pointerId != null && e.pointerId === wbPenDownId) wbPenDownId = null;
  // 선택 읽기 종료: 드래그면 영역 텍스트, 탭이면 그 단어 하나만 읽는다.
  if (wbSelecting) {
    if (e && e.pointerId != null && wbActivePointerId !== null && e.pointerId !== wbActivePointerId) return;
    wbSelecting = false;
    wbActivePointerId = null;
    const rect = wbSelRect;
    const start = wbSelStart;
    wbSelRect = null;
    wbSelStart = null;
    renderCurrentPage();
    const isTap = !rect || (rect.x2 - rect.x1 <= 0.008 && rect.y2 - rect.y1 <= 0.008);
    if (isTap && start) wbReadWordAt(start.x, start.y);      // 탭 → 단어 하나
    else if (rect) wbReadSelection(rect);                    // 드래그 → 영역
    if (e && e.preventDefault) e.preventDefault();
    return;
  }
  // 그리기/패닝을 시작한 그 포인터가 뗄 때만 종료. 손바닥의 up/cancel/leave가
  // 애플펜슬 획을 중간에 끊지 못하게 함.
  if (e && e.pointerId != null && wbActivePointerId !== null
      && e.pointerId !== wbActivePointerId) return;
  // 여기부터는 '소유 포인터(또는 id 불명)의 종료'다. 어느 분기로 나가든 상태를
  // 반드시 초기화해, wbActivePointerId/wbDrawing이 갇혀 다음 획이 통째로
  // 무시되는 일이 없게 한다. (예전엔 `if (!wbDrawing) return;`이 초기화 전에
  //  빠져나가 소유권 상태가 남는 경우가 있었다.)
  if (wbPanning) {
    wbPanning = false;
    wbPanStart = null;
    applyView(true); // final, exact view broadcast to everyone
  } else if (wbDrawing) {
    if (WB_DEBUG) {
      const pg = currentPageObj();
      const s = pg && wbCurrentId ? pg.strokes.get(wbCurrentId) : null;
      wbDbgNote(`  \u2514 점 ${s ? s.points.length : '?'}개 / move ${wbMoveCount}회`);
    }
    wbFlushSend(true);
  }
  wbDrawing = false;
  wbCurrentId = null;
  wbActivePointerId = null;
}

// Throttle view broadcasts while dragging so we don't flood the socket.
function queueViewBroadcast() {
  if (wbViewSendTimer) return;
  wbViewSendTimer = setTimeout(() => {
    wbViewSendTimer = null;
    socket.emit('wb-view', { zoom: wbZoom, panX: wbPanX, panY: wbPanY });
  }, 60);
}

// Normalize a pointer position to 0..1 WITHIN the page rectangle.
function wbNormPoint(e) {
  const rect = wbCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const px = (e.clientX - rect.left) * dpr;
  const py = (e.clientY - rect.top) * dpr;
  const r = pageRect();
  return {
    x: Math.min(1, Math.max(0, (px - r.x) / r.w)),
    y: Math.min(1, Math.max(0, (py - r.y) / r.h)),
  };
}

function wbQueueSend(point) {
  wbSendBuffer.push(point);
  if (!wbSendTimer) wbSendTimer = setTimeout(() => wbFlushSend(false), 40);
}
function wbFlushSend(done) {
  if (wbSendTimer) { clearTimeout(wbSendTimer); wbSendTimer = null; }
  const pg = currentPageObj();
  if (!wbCurrentId || !pg) { wbSendBuffer = []; return; }
  const stroke = pg.strokes.get(wbCurrentId);
  if (!stroke) { wbSendBuffer = []; return; }
  if (wbSendBuffer.length === 0 && !done) return;
  socket.emit('wb-stroke', {
    pageId: pg.id, id: wbCurrentId, color: stroke.color, width: stroke.width,
    erase: stroke.erase, highlight: stroke.highlight, points: wbSendBuffer, done: !!done,
  });
  wbSendBuffer = [];
}

// ---- Receiving strokes from others ----
socket.on('wb-stroke', ({ pageId, id, color, width, erase, highlight, points }) => {
  if (!pageId || !id || !Array.isArray(points)) return;
  const pg = wbPages.find((p) => p.id === pageId);
  if (!pg) return;
  let stroke = pg.strokes.get(id);
  if (!stroke) {
    stroke = { color: color || '#111', width: width || 3, erase: !!erase, highlight: !!highlight, points: [] };
    pg.strokes.set(id, stroke);
  }
  const fromIdx = stroke.points.length;
  points.forEach((p) => stroke.points.push(p));
  if (wbActive && pg.id === (currentPageObj() && currentPageObj().id)) {
    // Highlight strokes must redraw the whole page to keep uniform translucency.
    if (stroke.highlight) renderCurrentPage();
    else drawStrokeSegment(stroke, fromIdx === 0 ? 0 : fromIdx);
  }
});

socket.on('wb-clear', ({ pageId } = {}) => {
  if (pageId) {
    const pg = wbPages.find((p) => p.id === pageId);
    if (pg) pg.strokes.clear();
  } else {
    wbPages.forEach((p) => p.strokes.clear());
  }
  renderCurrentPage();
});

socket.on('wb-active', ({ active }) => {
  if (active) showWhiteboard(); else hideWhiteboard();
});

// New/changed page list from the server (after add-pdf / add-blank).
socket.on('wb-pages', (payload) => {
  applyPageList(payload);
  renderCurrentPage();
});

// Someone navigated to a page — follow along.
socket.on('wb-page', ({ index }) => {
  if (typeof index !== 'number') return;
  wbCurrentPage = Math.max(0, Math.min(index, wbPages.length - 1));
  renderCurrentPage();
});

// Someone zoomed/panned — follow along so everyone sees the same region.
socket.on('wb-view', ({ zoom, panX, panY } = {}) => {
  wbZoom = Math.min(4, Math.max(1, Number(zoom) || 1));
  wbPanX = Number(panX) || 0;
  wbPanY = Number(panY) || 0;
  clampStoredPan();
  if (wbActive) renderCurrentPage();
  updateZoomIndicator();
});

// Merge a server page list (metadata) into our local pages, preserving any
// strokes we already have for pages that still exist.
function applyPageList(payload) {
  const oldById = new Map(wbPages.map((p) => [p.id, p]));
  wbPages = (payload.pages || []).map((meta) => {
    const existing = oldById.get(meta.id);
    return {
      id: meta.id,
      type: meta.type,
      pdfId: meta.pdfId,
      pageIndex: meta.pageIndex,
      aspect: meta.aspect || 4 / 3,
      strokes: existing ? existing.strokes : new Map(),
    };
  });
  if (wbPages.length === 0) {
    wbPages = [{ id: 'pg-init', type: 'blank', aspect: 4 / 3, strokes: new Map() }];
  }
  if (typeof payload.currentPage === 'number') {
    wbCurrentPage = Math.max(0, Math.min(payload.currentPage, wbPages.length - 1));
  } else {
    wbCurrentPage = Math.min(wbCurrentPage, wbPages.length - 1);
  }
}

// Full snapshot on join: pages + strokes + current page + active.
function applyWhiteboardSnapshot(snapshot) {
  wbPageImageCache.clear();
  wbPages = (snapshot.pages || []).map((pg) => {
    const strokes = new Map();
    (pg.strokes || []).forEach((s) => {
      strokes.set(s.id, { color: s.color, width: s.width, erase: !!s.erase, highlight: !!s.highlight, points: s.points || [] });
    });
    return { id: pg.id, type: pg.type, pdfId: pg.pdfId, pageIndex: pg.pageIndex, aspect: pg.aspect || 4 / 3, strokes };
  });
  if (wbPages.length === 0) {
    wbPages = [{ id: 'pg-init', type: 'blank', aspect: 4 / 3, strokes: new Map() }];
  }
  wbCurrentPage = Math.max(0, Math.min(snapshot.currentPage || 0, wbPages.length - 1));
  if (snapshot.view) {
    wbZoom = Math.min(4, Math.max(1, Number(snapshot.view.zoom) || 1));
    wbPanX = Number(snapshot.view.panX) || 0;
    wbPanY = Number(snapshot.view.panY) || 0;
  } else {
    wbZoom = 1; wbPanX = 0; wbPanY = 0;
  }
  clampStoredPan();
  updateZoomIndicator();
  if (snapshot.active) showWhiteboard(); else if (!whiteboardOnlyMode) hideWhiteboard();
  if (wbActive) renderCurrentPage();
}

// ---- Navigation ----
function gotoPage(index, broadcast) {
  const n = Math.max(0, Math.min(index, wbPages.length - 1));
  wbCurrentPage = n;
  wbStopReading();       // 페이지를 넘기면 읽기를 멈춘다
  if (wbSentBar && !wbSentBar.classList.contains('hidden')) wbExitSentenceMode(); // 문장듣기도 종료
  renderCurrentPage();
  wbPrefetchPageText();  // 새 페이지 텍스트 미리 추출(즉시 재생 대비)
  if (broadcast) socket.emit('wb-page', { index: n });
}
function updatePageIndicator() {
  if (wbPageIndicator) wbPageIndicator.textContent = `${wbCurrentPage + 1} / ${wbPages.length}`;
}

// ---- Open / close ----
function openWhiteboard(broadcast) {
  showWhiteboard();
  if (broadcast) socket.emit('wb-open');
}
function closeWhiteboard(broadcast) {
  hideWhiteboard();
  if (broadcast) socket.emit('wb-close');
}
// 필기 열림/닫힘에 따라 화상 컨트롤(마이크·카메라·화면공유·필기·배경·나가기)을
// 상단 툴바 오른쪽 ↔ 하단 바로 이동. DOM 노드를 옮겨도 이벤트 핸들러는 유지되므로
// 기존 동작(마이크 토글, 배경 패널, 나가기 등)은 그대로 작동한다.
function moveCallControls(toToolbar) {
  const dest = toToolbar ? wbCallControls : controlsBar;
  if (!dest) return;
  const bgWrap = bgBtn ? bgBtn.closest('.bg-picker-wrap') : null;
  const items = [micBtn, camBtn, screenBtn, whiteboardBtn, bgWrap, leaveBtn].filter(Boolean);
  items.forEach((el) => { if (el.parentNode !== dest) dest.appendChild(el); });
  // 필기가 열리면 하단 바는 비므로 통째로 숨기고, 닫히면 다시 표시.
  if (controlsBar) controlsBar.classList.toggle('hidden', !!toToolbar);
}

function showWhiteboard() {
  wbActive = true;
  whiteboardPanel.classList.remove('hidden');
  if (callMain) callMain.classList.add('wb-active');
  if (whiteboardBtn) { whiteboardBtn.classList.add('active'); whiteboardBtn.textContent = '필기 닫기'; }
  moveCallControls(true);
  applyWbLayout();
  requestAnimationFrame(() => { reflowToolbar(true); sizeWhiteboardCanvas(); renderCurrentPage(); wbPrefetchPageText(); });
  if (typeof wbListenBtn !== 'undefined' && wbListenBtn) wbListenBtn.classList.toggle('hidden', !isHost);
}
function hideWhiteboard() {
  wbActive = false;
  wbStopReading(); // 필기를 닫으면 읽기를 멈춘다
  whiteboardPanel.classList.add('hidden');
  if (callMain) callMain.classList.remove('wb-active');
  if (whiteboardBtn) { whiteboardBtn.classList.remove('active'); whiteboardBtn.textContent = '필기'; }
  moveCallControls(false);
}

// ---- Whiteboard participant-strip layout: bottom / right / top-centre ----
// Reuses #video-grid as the strip (styled by CSS via .wb-thumb-* classes on
// .call-main). A drag handle between the board and the strip resizes it.
function applyWbLayout() {
  if (!callMain) return;
  callMain.classList.toggle('wb-thumb-right', wbThumbPosition === 'right');
  callMain.classList.toggle('wb-thumb-top', wbThumbPosition === 'top');

  const size = wbThumbPosition === 'right' ? wbRightSize : wbBottomSize;
  callMain.style.setProperty('--wb-thumb-size', `${size}px`);

  // Create the resize handle once and keep it sitting between the board and
  // the participant strip (i.e. right before #video-grid).
  let handle = document.getElementById('wb-resize-handle');
  if (!handle) {
    handle = document.createElement('div');
    handle.id = 'wb-resize-handle';
    handle.className = 'wb-resize-handle';
    handle.title = '드래그해서 크기 조절';
    attachWbResizeHandlers(handle);
  }
  if (videoGrid && videoGrid.parentNode === callMain && handle.nextSibling !== videoGrid) {
    callMain.insertBefore(handle, videoGrid);
  }

  if (wbLayoutBottomBtn) wbLayoutBottomBtn.classList.toggle('active', wbThumbPosition === 'bottom');
  if (wbLayoutRightBtn) wbLayoutRightBtn.classList.toggle('active', wbThumbPosition === 'right');
  if (wbLayoutTopBtn) wbLayoutTopBtn.classList.toggle('active', wbThumbPosition === 'top');

  if (wbActive) requestAnimationFrame(() => { sizeWhiteboardCanvas(); renderCurrentPage(); });
}

function attachWbResizeHandlers(handle) {
  let dragging = false, startPos = 0, startSize = 0, raf = 0;
  const pt = (e) => (e.touches && e.touches[0]) ? e.touches[0] : e;

  function down(e) {
    dragging = true;
    handle.classList.add('dragging');
    const p = pt(e);
    startPos = wbThumbPosition === 'right' ? p.clientX : p.clientY;
    startSize = wbThumbPosition === 'right' ? wbRightSize : wbBottomSize;
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', up);
    e.preventDefault();
  }
  function move(e) {
    if (!dragging) return;
    const p = pt(e);
    const cur = wbThumbPosition === 'right' ? p.clientX : p.clientY;
    let delta = startPos - cur;              // right: drag left grows; bottom: drag up grows
    if (wbThumbPosition === 'top') delta = -delta;  // strip above the handle: drag down grows
    if (wbThumbPosition === 'right') wbRightSize = clamp(startSize + delta, 160, 480);
    else wbBottomSize = clamp(startSize + delta, 90, 320);
    const size = wbThumbPosition === 'right' ? wbRightSize : wbBottomSize;
    callMain.style.setProperty('--wb-thumb-size', `${size}px`);
    if (wbActive && !raf) {
      raf = requestAnimationFrame(() => { raf = 0; sizeWhiteboardCanvas(); renderCurrentPage(); });
    }
    e.preventDefault();
  }
  function up() {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.removeEventListener('touchmove', move);
    document.removeEventListener('touchend', up);
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (wbActive) { sizeWhiteboardCanvas(); renderCurrentPage(); }
    saveWbLayoutPrefs();
  }
  handle.addEventListener('mousedown', down);
  handle.addEventListener('touchstart', down, { passive: false });
}

function setWbLayout(pos) {
  if (wbThumbPosition === pos) return;
  wbThumbPosition = pos;
  saveWbLayoutPrefs();
  applyWbLayout();
}
if (wbLayoutBottomBtn) wbLayoutBottomBtn.addEventListener('click', () => setWbLayout('bottom'));
if (wbLayoutRightBtn) wbLayoutRightBtn.addEventListener('click', () => setWbLayout('right'));
if (wbLayoutTopBtn) wbLayoutTopBtn.addEventListener('click', () => setWbLayout('top'));

// ---- Toolbar wiring ----
if (whiteboardBtn) {
  whiteboardBtn.addEventListener('click', () => {
    if (wbActive) closeWhiteboard(true); else openWhiteboard(true);
  });
}
if (wbCloseBtn) wbCloseBtn.addEventListener('click', () => closeWhiteboard(true));
if (wbClearBtn) {
  wbClearBtn.addEventListener('click', () => {
    const pg = currentPageObj();
    if (!pg) return;
    pg.strokes.clear();
    renderCurrentPage();
    socket.emit('wb-clear', { pageId: pg.id });
  });
}
if (wbAddPdfBtn && wbPdfInput) {
  wbAddPdfBtn.addEventListener('click', () => wbPdfInput.click());
  wbPdfInput.addEventListener('change', async () => {
    const files = Array.from(wbPdfInput.files || []);
    for (const f of files) { await addPdfFile(f); }
    wbPdfInput.value = '';
  });
}
if (wbAddBlankBtn) wbAddBlankBtn.addEventListener('click', () => socket.emit('wb-add-blank'));

// 페이지 삭제 / PDF 삭제 (서버가 목록을 다시 동기화).
const wbDelPageBtn = document.getElementById('wb-del-page-btn');
const wbDelPdfBtn = document.getElementById('wb-del-pdf-btn');
if (wbDelPageBtn) wbDelPageBtn.addEventListener('click', () => {
  if (wbPages.length <= 1) { triggerToastIfAvailable('마지막 한 장은 삭제할 수 없어요.'); return; }
  if (!confirm('현재 페이지를 삭제할까요? (되돌릴 수 없어요)')) return;
  socket.emit('wb-del-page', { index: wbCurrentPage });
});
if (wbDelPdfBtn) wbDelPdfBtn.addEventListener('click', () => {
  const pg = currentPageObj();
  if (!pg || pg.type !== 'pdf') { triggerToastIfAvailable('현재 페이지는 PDF가 아니에요.'); return; }
  if (!confirm('이 PDF의 모든 페이지를 삭제할까요? (되돌릴 수 없어요)')) return;
  socket.emit('wb-del-pdf', { pdfId: pg.pdfId });
});

// ---- 수업 녹화: 화면(탭/창) 영상 + 소리(화면 소리 + 내 마이크)를 녹화해 파일로 저장 ----
const wbRecordBtn = document.getElementById('wb-record-btn');
let wbRecorder = null;
let wbRecChunks = [];
let wbRecDisplay = null;
let wbRecAC = null;
function wbSetRecordingUI(on) {
  if (!wbRecordBtn) return;
  wbRecordBtn.textContent = on ? '⏹ 녹화중지' : '🔴 녹화';
  wbRecordBtn.classList.toggle('active', on);
}
function wbFinishRecording() {
  wbSetRecordingUI(false);
  try {
    const blob = new Blob(wbRecChunks, { type: 'video/webm' });
    wbRecChunks = [];
    if (blob.size) {
      const url = URL.createObjectURL(blob);
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const a = document.createElement('a');
      a.href = url;
      a.download = `수업녹화_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.webm`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 15000);
      triggerToastIfAvailable('녹화 파일을 저장했어요.');
    }
  } catch (_) {}
  if (wbRecDisplay) { wbRecDisplay.getTracks().forEach((t) => t.stop()); wbRecDisplay = null; }
  if (wbRecAC) { try { wbRecAC.close(); } catch (_) {} wbRecAC = null; }
  wbRecorder = null;
}
async function wbStartRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia || typeof MediaRecorder === 'undefined') {
    triggerToastIfAvailable('이 브라우저는 화면 녹화를 지원하지 않아요.'); return;
  }
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
    wbRecDisplay = display;
    const mixed = new MediaStream();
    const vtrack = display.getVideoTracks()[0];
    if (vtrack) mixed.addTrack(vtrack);
    // 오디오: 화면(탭/시스템) 소리 + 내 마이크를 하나로 믹스.
    try {
      wbRecAC = new (window.AudioContext || window.webkitAudioContext)();
      const dest = wbRecAC.createMediaStreamDestination();
      let mixedAny = false;
      if (display.getAudioTracks().length) { wbRecAC.createMediaStreamSource(new MediaStream([display.getAudioTracks()[0]])).connect(dest); mixedAny = true; }
      if (localStream && localStream.getAudioTracks().length) { wbRecAC.createMediaStreamSource(new MediaStream([localStream.getAudioTracks()[0]])).connect(dest); mixedAny = true; }
      const atrack = mixedAny ? dest.stream.getAudioTracks()[0] : null;
      if (atrack) mixed.addTrack(atrack);
    } catch (_) {
      if (display.getAudioTracks().length) mixed.addTrack(display.getAudioTracks()[0]); // 믹스 실패 시 화면 소리만
    }
    const cands = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    const mime = cands.find((m) => MediaRecorder.isTypeSupported(m)) || '';
    wbRecorder = new MediaRecorder(mixed, mime ? { mimeType: mime } : undefined);
    wbRecChunks = [];
    wbRecorder.ondataavailable = (e) => { if (e.data && e.data.size) wbRecChunks.push(e.data); };
    wbRecorder.onstop = wbFinishRecording;
    if (vtrack) vtrack.addEventListener('ended', () => { if (wbRecorder && wbRecorder.state !== 'inactive') wbRecorder.stop(); }); // '공유 중지' 시 녹화도 종료
    wbRecorder.start(1000);
    wbSetRecordingUI(true);
    triggerToastIfAvailable('녹화를 시작했어요. 녹화할 화면/창을 선택하셨는지 확인하세요.');
  } catch (_) {
    triggerToastIfAvailable('녹화를 시작하지 못했어요(권한을 취소했을 수 있어요).');
    if (wbRecDisplay) { wbRecDisplay.getTracks().forEach((t) => t.stop()); wbRecDisplay = null; }
  }
}
if (wbRecordBtn) wbRecordBtn.addEventListener('click', () => {
  if (wbRecorder && wbRecorder.state !== 'inactive') wbRecorder.stop();
  else wbStartRecording();
});
if (wbPrevBtn) wbPrevBtn.addEventListener('click', () => gotoPage(wbCurrentPage - 1, true));
if (wbNextBtn) wbNextBtn.addEventListener('click', () => gotoPage(wbCurrentPage + 1, true));

// ---- Export / share (PNG for one page, PDF for all pages) ----
// Renders one page (PDF background + its strokes) onto a fresh canvas at a
// high, fixed resolution so the export is crisp regardless of screen size.
async function renderPageToCanvas(pg, maxW) {
  const targetW = maxW || 1600;
  const aspect = pg.aspect || 4 / 3;
  const out = document.createElement('canvas');
  out.width = Math.round(targetW);
  out.height = Math.round(targetW / aspect);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);

  if (pg.type === 'pdf') {
    if (!wbPageImageCache.get(pg.id)) await ensurePdfPageRendered(pg);
    const img = wbPageImageCache.get(pg.id);
    if (img) ctx.drawImage(img, 0, 0, out.width, out.height);
  }
  // Strokes (normalized to the whole page rect = whole canvas here).
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  pg.strokes.forEach((stroke) => {
    const pts = stroke.points;
    if (!pts.length) return;
    ctx.globalAlpha = stroke.highlight ? 0.4 : 1;   // translucent for highlighter
    ctx.strokeStyle = stroke.erase ? '#ffffff' : stroke.color;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = stroke.width * (out.height / 800) + 0.5;
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x * out.width, pts[0].y * out.height, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0].x * out.width, pts[0].y * out.height);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x * out.width, pts[i].y * out.height);
    ctx.stroke();
  });
  ctx.globalAlpha = 1;
  return out;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

// Share a file via the native share sheet (KakaoTalk shows up here on phones);
// falls back to a normal download on desktop / unsupported browsers.
async function shareOrDownload(blob, filename, title) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: title || filename });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return; // user cancelled the share sheet
      // otherwise fall through to download
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  triggerToastIfAvailable('저장했어요. 저장된 파일을 카카오톡으로 공유하세요.');
}

if (wbSharePngBtn) {
  wbSharePngBtn.addEventListener('click', async () => {
    const pg = currentPageObj();
    if (!pg) return;
    try {
      if (wbLoading) wbLoading.classList.remove('hidden');
      const canvas = await renderPageToCanvas(pg, 1600);
      const blob = await canvasToBlob(canvas, 'image/png');
      const stamp = new Date().toISOString().slice(0, 10);
      await shareOrDownload(blob, `필기_${wbCurrentPage + 1}쪽_${stamp}.png`, '수업 필기');
    } catch (e) {
      triggerToastIfAvailable('이미지를 만들지 못했어요.');
    } finally {
      if (wbLoading) wbLoading.classList.add('hidden');
    }
  });
}

// 📥 PAGE 저장 — 현재 페이지를 PNG로 렌더해 이 기기에 파일로 저장(공유시트 없이 다운로드).
const wbSavePngBtn = document.getElementById('wb-save-png-btn');
if (wbSavePngBtn) {
  wbSavePngBtn.addEventListener('click', async () => {
    const pg = currentPageObj();
    if (!pg) return;
    try {
      if (wbLoading) wbLoading.classList.remove('hidden');
      const canvas = await renderPageToCanvas(pg, 1600);
      const blob = await canvasToBlob(canvas, 'image/png');
      const stamp = new Date().toISOString().slice(0, 10);
      downloadBlob(blob, `필기_${wbCurrentPage + 1}쪽_${stamp}.png`);
      triggerToastIfAvailable('이미지로 저장했어요.');
    } catch (e) {
      triggerToastIfAvailable('이미지를 만들지 못했어요.');
    } finally {
      if (wbLoading) wbLoading.classList.add('hidden');
    }
  });
}

// Build a single multi-page PDF (all whiteboard pages, backgrounds + strokes)
// and return it as a Blob. Shared by both the "저장" and "공유" buttons.
async function buildWhiteboardPdfBlob() {
  const jspdfNS = window.jspdf || window.jsPDF;
  const JsPDF = jspdfNS && (jspdfNS.jsPDF || jspdfNS);
  if (!JsPDF) { throw new Error('jspdf-not-ready'); }
  let doc = null;
  for (let i = 0; i < wbPages.length; i++) {
    const canvas = await renderPageToCanvas(wbPages[i], 1400);
    const imgData = canvas.toDataURL('image/jpeg', 0.85);
    const orientation = canvas.width >= canvas.height ? 'landscape' : 'portrait';
    if (!doc) {
      doc = new JsPDF({ orientation, unit: 'px', format: [canvas.width, canvas.height] });
    } else {
      doc.addPage([canvas.width, canvas.height], orientation);
    }
    doc.addImage(imgData, 'JPEG', 0, 0, canvas.width, canvas.height);
  }
  return doc.output('blob');
}

// Plain download to the device (no share sheet).
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// 📥 전체 PDF 저장 — always saves the file to this device.
if (wbSharePdfBtn) {
  wbSharePdfBtn.addEventListener('click', async () => {
    if (!wbPages.length) return;
    try {
      if (wbLoading) { wbLoading.textContent = 'PDF 만드는 중...'; wbLoading.classList.remove('hidden'); }
      const blob = await buildWhiteboardPdfBlob();
      const stamp = new Date().toISOString().slice(0, 10);
      downloadBlob(blob, `수업필기_${stamp}.pdf`);
      triggerToastIfAvailable('PDF로 저장했어요.');
    } catch (e) {
      triggerToastIfAvailable(e && e.message === 'jspdf-not-ready'
        ? 'PDF 기능 로딩 중입니다. 잠시 후 다시 시도해주세요.'
        : 'PDF를 만들지 못했어요.');
    } finally {
      if (wbLoading) { wbLoading.textContent = 'PDF 불러오는 중...'; wbLoading.classList.add('hidden'); }
    }
  });
}

// 📤 전체 PDF 공유 — opens the OS share sheet (KakaoTalk shows up on phones/
// tablets); on desktops without file-sharing it falls back to a download.
if (wbSharePdfFileBtn) {
  wbSharePdfFileBtn.addEventListener('click', async () => {
    if (!wbPages.length) return;
    try {
      if (wbLoading) { wbLoading.textContent = 'PDF 만드는 중...'; wbLoading.classList.remove('hidden'); }
      const blob = await buildWhiteboardPdfBlob();
      const stamp = new Date().toISOString().slice(0, 10);
      await shareOrDownload(blob, `수업필기_${stamp}.pdf`, '수업 필기');
    } catch (e) {
      triggerToastIfAvailable(e && e.message === 'jspdf-not-ready'
        ? 'PDF 기능 로딩 중입니다. 잠시 후 다시 시도해주세요.'
        : 'PDF를 만들지 못했어요.');
    } finally {
      if (wbLoading) { wbLoading.textContent = 'PDF 불러오는 중...'; wbLoading.classList.add('hidden'); }
    }
  });
}


// #rrggbb 색을 흰색 쪽으로 amt(0~1)만큼 섞어 연하게. 연필 색 계산에 사용.
function wbLighten(hex, amt) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = Math.round(r + (255 - r) * amt);
  g = Math.round(g + (255 - g) * amt);
  b = Math.round(b + (255 - b) * amt);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

// Highlight the active tool button (pen / pencil / highlighter / eraser / pan).
function wbSetTool(tool) {
  wbTool = tool;
  if (wbPenBtn) wbPenBtn.classList.toggle('active', tool === 'pen');
  if (wbPencilBtn) wbPencilBtn.classList.toggle('active', tool === 'pencil');
  if (wbHiBtn) wbHiBtn.classList.toggle('active', tool === 'highlight');
  if (wbEraserBtn) wbEraserBtn.classList.toggle('active', tool === 'eraser');
  if (wbPanBtn) wbPanBtn.classList.toggle('active', tool === 'pan');
  if (wbReadSelBtn) wbReadSelBtn.classList.toggle('active', tool === 'readselect');
  if (wbCanvas) wbCanvas.classList.toggle('wb-pan-cursor', tool === 'pan');
  if (wbCanvas) wbCanvas.classList.toggle('wb-select-cursor', tool === 'readselect');
}

function wbSetColorActive(color) {
  document.querySelectorAll('.wb-color').forEach((b) => {
    b.classList.toggle('active', b.dataset.color === color);
  });
}

document.querySelectorAll('.wb-color').forEach((btn) => {
  btn.addEventListener('click', () => {
    wbColor = btn.dataset.color;
    wbSetColorActive(wbColor);
    // Picking a colour keeps you in pen or highlighter; only pulls you out of
    // eraser/pan (where a colour choice otherwise wouldn't do anything).
    if (wbTool === 'eraser' || wbTool === 'pan') wbSetTool('pen');
  });
});
// 상단 정리용 드롭다운(📄 페이지 / 👥 배치) 열고 닫기.
// 버튼 자체의 기존 동작(PDF 추가·배치 변경 등)은 각 id 핸들러가 그대로 처리하고,
// 여기서는 메뉴를 여닫기만 한다.
function wbCloseAllDropdowns() {
  document.querySelectorAll('.wb-dropdown.open').forEach((o) => {
    o.classList.remove('open');
    const t = o.querySelector('.wb-dd-toggle');
    if (t) t.setAttribute('aria-expanded', 'false');
  });
}
document.querySelectorAll('.wb-dropdown').forEach((dd) => {
  const toggle = dd.querySelector('.wb-dd-toggle');
  const menu = dd.querySelector('.wb-dd-menu');
  if (!toggle) return;
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = !dd.classList.contains('open');
    wbCloseAllDropdowns();
    dd.classList.toggle('open', willOpen);
    toggle.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  });
  // 메뉴 안의 항목을 고르면 닫는다. (단, '더보기'·'페이지'는 줌·페이지 이동 등
  //  반복 조작을 위해 안쪽 클릭으로 닫지 않고, 바깥 클릭이나 토글로만 닫는다.)
  if (menu && !dd.classList.contains('wb-dd-keepopen')) menu.addEventListener('click', () => wbCloseAllDropdowns());
});
// 바깥을 클릭하면 닫는다.
document.addEventListener('click', wbCloseAllDropdowns);

// ---- 상단 툴바 구성 ----
// 그리기 도구(색·연필·펜·형광펜·지우개·이동·굵기)는 항상 상단에 보이게 둔다.
// 듣기 관련 버튼(전체읽기·선택읽기·속도·다시듣기·문장듣기·듣기시험)은 항상 '더보기'
// 안으로 넣어 상단을 넓게 유지한다. 페이지·줌 바만 폭이 부족할 때 '더보기'로 접는다.
const wbMoreDd = document.getElementById('wb-more-dd');
const wbMoreMenu = wbMoreDd && wbMoreDd.querySelector('.wb-dd-menu');
const wbToolsRow = document.querySelector('.wb-tools');

// 듣기 관련 버튼을 '더보기' 안으로 상시 이동.
['wb-read-btn', 'wb-readsel-btn', 'wb-rate-btn', 'wb-replay-btn', 'wb-sent-btn', 'wb-listen-btn']
  .forEach((id) => { const el = document.getElementById(id); if (el && wbMoreMenu) wbMoreMenu.appendChild(el); });
if (wbMoreDd) wbMoreDd.classList.remove('hidden'); // '더보기'는 항상 표시

// 접을 대상 없음(그리기 도구는 항상 상단, 페이지 이동은 인라인, 줌/삭제는 '페이지' 안, 듣기는 '더보기' 안).
const wbCollapsibles = [];

// 도구 줄이 두 줄 이상으로 넘쳤는지 판정(자식들의 상단 위치가 갈라지면 래핑).
function wbToolbarWraps() {
  if (!wbToolsRow) return false;
  const kids = Array.from(wbToolsRow.children).filter((c) => c.offsetParent !== null);
  if (kids.length < 2) return false;
  const top0 = kids[0].offsetTop;
  return kids.some((c) => c.offsetTop - top0 > 20);
}

let wbLastReflowW = -1;
function reflowToolbar(force) {
  if (!wbMoreDd || !wbMoreMenu || !wbToolsRow || !whiteboardPanel) return;
  if (whiteboardPanel.classList.contains('hidden')) return;
  const w = whiteboardPanel.clientWidth || 0;
  if (!force && w === wbLastReflowW) return;
  wbLastReflowW = w;
  // 페이지·줌 바를 펼쳤다가, 한 줄에 안 들어가면 '더보기'로 접는다.
  wbCollapsibles.forEach(({ el, slot }) => {
    if (el && slot && el.parentNode === wbMoreMenu) slot.after(el);
  });
  for (const { el } of wbCollapsibles) {
    if (!wbToolbarWraps()) break;
    if (el) wbMoreMenu.appendChild(el);
  }
  if (wbActive) sizeWhiteboardCanvas();
}
window.addEventListener('resize', () => reflowToolbar(false));

if (wbPenBtn) wbPenBtn.addEventListener('click', () => wbSetTool('pen'));
if (wbPencilBtn) wbPencilBtn.addEventListener('click', () => wbSetTool('pencil'));
if (wbHiBtn) wbHiBtn.addEventListener('click', () => {
  // A black highlighter looks like a grey smudge, so default to yellow the first
  // time you reach for it from black.
  if (wbColor === '#111111') { wbColor = '#ffd400'; wbSetColorActive(wbColor); }
  wbSetTool('highlight');
});
if (wbEraserBtn) wbEraserBtn.addEventListener('click', () => wbSetTool('eraser'));
if (wbPanBtn) wbPanBtn.addEventListener('click', () => wbSetTool('pan'));
// 손가락 모드 토글: 한 손가락으로 '이동'(기본) ↔ '그리기' 전환. 기기별 로컬 설정.
const wbFingerModeBtn = document.getElementById('wb-fingermode-btn');
function wbUpdateFingerModeUI() {
  if (!wbFingerModeBtn) return;
  wbFingerModeBtn.classList.toggle('active', wbFingerDraw);
  wbFingerModeBtn.textContent = wbFingerDraw ? '✍️' : '✌️';
  wbFingerModeBtn.title = wbFingerDraw
    ? '손가락 = 그리기. 탭하면 손가락으로 화면 이동/확대로 전환됩니다.'
    : '손가락 = 화면 이동/확대 (필기는 펜으로). 탭하면 손가락으로 그리기로 전환됩니다.';
}
if (wbFingerModeBtn) {
  wbUpdateFingerModeUI();
  wbFingerModeBtn.addEventListener('click', () => {
    wbFingerDraw = !wbFingerDraw;
    try { localStorage.setItem('vc_wb_finger_draw', wbFingerDraw ? '1' : '0'); } catch (_) {}
    wbUpdateFingerModeUI();
    triggerToastIfAvailable(wbFingerDraw
      ? '손가락으로 그리기 모드예요.'
      : '손가락으로 화면 이동 모드예요. (필기는 펜으로)');
  });
}
if (wbSizeInput) wbSizeInput.addEventListener('input', () => { wbSize = Number(wbSizeInput.value) || 4; });

// Zoom controls (synced to everyone via applyView/zoomBy).
if (wbZoomInBtn) wbZoomInBtn.addEventListener('click', () => zoomBy(1.25));
if (wbZoomOutBtn) wbZoomOutBtn.addEventListener('click', () => zoomBy(1 / 1.25));
if (wbZoomFitBtn) wbZoomFitBtn.addEventListener('click', () => {
  wbZoom = 1; wbPanX = 0; wbPanY = 0; applyView(true);
});

// ---- 현재 PDF 페이지를 영어로 읽어주기 (브라우저 내장 음성합성 + PDF.js 텍스트 추출) ----
const wbReadBtn = document.getElementById('wb-read-btn');
const wbTTS = window.speechSynthesis || null;
const wbPageTextCache = new Map(); // pageId -> 추출 텍스트('' = 읽을 텍스트 없음)
const wbPageItemsCache = new Map(); // pageId -> [{str, x1,y1,x2,y2, cx,cy}] (정규화 위치)
let wbSpeaking = false;
// 낭독 속도(모두에게 같은 속도로 들리도록 브로드캐스트에 실어 보낸다) + 마지막 읽은 내용.
const wbReadRates = [
  { label: '아주 느리게', rate: 0.5 },
  { label: '느리게', rate: 0.65 },
  { label: '보통', rate: 0.85 },
  { label: '빠르게', rate: 1.0 },
  { label: '아주 빠르게', rate: 1.2 },
];
let wbReadRateIdx = 2; // 보통
let wbReadRate = wbReadRates[wbReadRateIdx].rate;
let wbLastReadText = '';
let wbReadOwner = false;   // 내가 이번 '공유 읽기'를 시작했는지(정지 방송 여부 판단)
let wbTTSUnlocked = false; // iOS: 사용자 제스처로 음성합성을 한 번 깨워야 원격 재생이 됨
// 아무 곳이나 처음 눌렀을 때 음성합성을 무음으로 한 번 깨운다(원격 재생 허용).
function wbPrimeTTS() {
  if (!wbTTS || wbTTSUnlocked) return;
  wbTTSUnlocked = true;
  try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; wbTTS.speak(u); } catch (_) {}
  hideSoundBanner();
}
document.addEventListener('pointerdown', wbPrimeTTS);
document.addEventListener('click', wbPrimeTTS);

// ---- '소리 켜기' 안내 배너 ----
// iOS 등은 사용자 조작 없이 음성이 막히므로, 입장 후 한 번 눌러 확실히 깨우게 안내한다.
let wbSoundBanner = null;
function ensureSoundBanner() {
  if (wbSoundBanner) return wbSoundBanner;
  const el = document.createElement('div');
  el.className = 'sound-enable hidden';
  const label = document.createElement('span');
  label.textContent = '🔊 영어 낭독 소리를 켜려면 눌러주세요';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '소리 켜기';
  btn.addEventListener('click', () => {
    wbTTSUnlocked = true; // 이 클릭(제스처) 안에서 실제 발화 → 확실히 잠금 해제
    try {
      if (wbTTS) { const u = new SpeechSynthesisUtterance('Sound is on.'); u.lang = 'en-US'; wbTTS.speak(u); }
    } catch (_) {}
    hideSoundBanner();
    triggerToastIfAvailable('소리가 켜졌어요. 이제 영어 낭독이 들립니다.');
  });
  el.appendChild(label);
  el.appendChild(btn);
  document.body.appendChild(el);
  wbSoundBanner = el;
  return el;
}
function showSoundBanner() {
  if (!wbTTS || wbTTSUnlocked) return; // 미지원이거나 이미 켜졌으면 표시하지 않음
  ensureSoundBanner().classList.remove('hidden');
}
function hideSoundBanner() {
  if (wbSoundBanner) wbSoundBanner.classList.add('hidden');
}

// PDF 페이지의 텍스트를 추출한다(줄바꿈 위치는 y좌표 변화로 근사).
async function wbExtractPageText(pg) {
  if (!pg || pg.type !== 'pdf') return '';
  try {
    const doc = await loadPdfDoc(pg.pdfId);
    const page = await doc.getPage(pg.pageIndex);
    const tc = await page.getTextContent();
    let out = '';
    let lastY = null;
    tc.items.forEach((it) => {
      if (!it || !it.str) return;
      const y = it.transform ? it.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 4) out += '\n';
      out += it.str + (it.hasEOL ? '\n' : ' ');
      lastY = y;
    });
    return out.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  } catch (_) { return ''; }
}

// 현재 페이지 텍스트를 미리 뽑아 캐시(클릭 시 사용자 제스처 안에서 바로 재생 → iOS 호환).
function wbPrefetchPageText() {
  const pg = currentPageObj();
  if (!pg || pg.type !== 'pdf') return;
  if (!wbPageTextCache.has(pg.id)) wbExtractPageText(pg).then((t) => wbPageTextCache.set(pg.id, t));
  if (!wbPageItemsCache.has(pg.id)) wbExtractPageItems(pg).then((it) => wbPageItemsCache.set(pg.id, it));
}

// PDF 페이지의 단어(텍스트 항목)들을 정규화 위치와 함께 추출한다(선택 읽기용).
async function wbExtractPageItems(pg) {
  if (!pg || pg.type !== 'pdf') return [];
  try {
    const doc = await loadPdfDoc(pg.pdfId);
    const page = await doc.getPage(pg.pageIndex);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = [];
    tc.items.forEach((it) => {
      if (!it || !it.str || !it.str.trim()) return;
      const tr = it.transform;
      if (!tr) return;
      const ex = tr[4], fy = tr[5];
      const w = it.width || 0;
      const h = it.height || Math.abs(tr[3]) || 10;
      const x1 = ex / vp.width, x2 = (ex + w) / vp.width;
      const yTop = 1 - (fy + h) / vp.height, yBot = 1 - fy / vp.height; // PDF는 y가 아래→위라 뒤집음
      items.push({ str: it.str, x1, y1: yTop, x2, y2: yBot, cx: (x1 + x2) / 2, cy: (yTop + yBot) / 2 });
    });
    return items;
  } catch (_) { return []; }
}

// 선택 사각형 안(중심이 들어오는) 단어들을 읽기 순서(위→아래, 좌→우)로 이어 붙인다.
function wbTextInRect(items, rect) {
  const sel = items.filter((it) => it.cx >= rect.x1 && it.cx <= rect.x2 && it.cy >= rect.y1 && it.cy <= rect.y2);
  sel.sort((a, b) => (Math.abs(a.cy - b.cy) > 0.012 ? a.cy - b.cy : a.cx - b.cx));
  return sel.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
}

// 선택 영역을 읽는다(모두에게 브로드캐스트).
async function wbReadSelection(rect) {
  if (!wbTTS) { triggerToastIfAvailable('이 브라우저는 음성 읽기를 지원하지 않아요.'); return; }
  const pg = currentPageObj();
  if (!pg || pg.type !== 'pdf') { triggerToastIfAvailable('PDF 페이지에서만 선택 읽기가 돼요.'); return; }
  let items = wbPageItemsCache.get(pg.id);
  if (!items) { items = await wbExtractPageItems(pg); wbPageItemsCache.set(pg.id, items); }
  const text = wbTextInRect(items, rect);
  if (!text) { triggerToastIfAvailable('선택 영역에 읽을 텍스트가 없어요.'); return; }
  wbReadOwner = true;
  wbSpeakText(text);
  socket.emit('wb-read', { action: 'play', text: text.slice(0, 8000), rate: wbReadRate });
}

// (x,y)(정규화) 위치의 단어 하나를 찾는다. 여러 단어가 든 텍스트 항목이면
// 문자 수 비례로 탭 위치의 단어만 골라낸다.
function wbWordAtPoint(items, x, y) {
  let hit = items.find((it) => x >= it.x1 && x <= it.x2 && y >= it.y1 && y <= it.y2);
  if (!hit) {
    let best = null, bestD = Infinity;
    items.forEach((it) => {
      const dx = Math.max(it.x1 - x, 0, x - it.x2);
      const dy = Math.max(it.y1 - y, 0, y - it.y2);
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = it; }
    });
    if (!best || bestD > 0.02 * 0.02) return ''; // 너무 멀면 무시
    hit = best;
  }
  const raw = hit.str;
  const parts = raw.split(/(\s+)/); // 구분자 유지해 오프셋 계산
  const total = raw.length || 1;
  const frac = Math.min(1, Math.max(0, (x - hit.x1) / Math.max(hit.x2 - hit.x1, 1e-6)));
  const target = frac * total;
  let acc = 0, chosen = '';
  for (const w of parts) {
    if (w.trim() && target >= acc && target <= acc + w.length) { chosen = w.trim(); break; }
    acc += w.length;
  }
  if (!chosen) chosen = (raw.trim().split(/\s+/)[0] || raw).trim();
  return chosen.replace(/^[^\w'’-]+|[^\w'’-]+$/g, '') || chosen; // 앞뒤 구두점 정리
}

// 탭한 위치의 단어 하나만 읽는다(모두에게 브로드캐스트).
async function wbReadWordAt(x, y) {
  if (!wbTTS) { triggerToastIfAvailable('이 브라우저는 음성 읽기를 지원하지 않아요.'); return; }
  const pg = currentPageObj();
  if (!pg || pg.type !== 'pdf') { triggerToastIfAvailable('PDF 페이지에서만 읽어줄 수 있어요.'); return; }
  let items = wbPageItemsCache.get(pg.id);
  if (!items) { items = await wbExtractPageItems(pg); wbPageItemsCache.set(pg.id, items); }
  const word = wbWordAtPoint(items, x, y);
  if (!word) { triggerToastIfAvailable('그 위치에 단어가 없어요.'); return; }
  wbReadOwner = true;
  wbSpeakText(word);
  socket.emit('wb-read', { action: 'play', text: word.slice(0, 200), rate: wbReadRate });
}

function wbPickEnglishVoice() {
  if (!wbTTS) return null;
  const vs = wbTTS.getVoices() || [];
  return vs.find((v) => /^en[-_]US/i.test(v.lang) && /natural|samantha|google|siri/i.test(v.name))
      || vs.find((v) => /^en[-_]US/i.test(v.lang))
      || vs.find((v) => /^en/i.test(v.lang))
      || null;
}

function wbSetReadingUI(on) {
  wbSpeaking = on;
  if (!wbReadBtn) return;
  wbReadBtn.textContent = on ? '⏹ 정지' : '🔊 읽기';
  wbReadBtn.classList.toggle('active', on);
}

function wbStopReading() {
  if (wbTTS) wbTTS.cancel();
  wbSetReadingUI(false);
  if (wbReadOwner) { socket.emit('wb-read', { action: 'stop' }); wbReadOwner = false; }
}

// 긴 지문은 문장 단위로 끊어 안정적으로 읽는다(일부 브라우저의 긴 문장 끊김 방지).
function wbSpeakText(text, rate) {
  if (!wbTTS || !text) return;
  wbLastReadText = text;            // '다시 듣기'용으로 기억
  const useRate = rate || wbReadRate;
  wbTTS.cancel();
  const chunks = (text.match(/[^.!?\n]+[.!?]?/g) || [text]).map((s) => s.trim()).filter(Boolean);
  if (!chunks.length) { triggerToastIfAvailable('읽을 텍스트가 없어요.'); return; }
  const voice = wbPickEnglishVoice();
  let i = 0;
  const speakNext = () => {
    if (i >= chunks.length) { wbSetReadingUI(false); return; }
    const u = new SpeechSynthesisUtterance(chunks[i++]);
    u.lang = 'en-US';
    if (voice) u.voice = voice;
    u.rate = useRate;
    u.onend = speakNext;
    u.onerror = () => wbSetReadingUI(false);
    wbTTS.speak(u);
  };
  wbSetReadingUI(true);
  speakNext();
}

async function wbToggleReading() {
  if (!wbTTS) { triggerToastIfAvailable('이 브라우저는 음성 읽기를 지원하지 않아요.'); return; }
  wbPrimeTTS();
  if (wbSpeaking || wbTTS.speaking) { wbStopReading(); return; }
  const pg = currentPageObj();
  if (!pg || pg.type !== 'pdf') { triggerToastIfAvailable('PDF 페이지에서만 읽어줄 수 있어요.'); return; }
  if (wbPageTextCache.has(pg.id)) { // 캐시 있으면 제스처 안에서 즉시 재생
    const t = wbPageTextCache.get(pg.id);
    if (!t) { triggerToastIfAvailable('읽을 텍스트가 없어요. (이미지형 PDF이거나 빈 페이지)'); return; }
    wbReadOwner = true;
    wbSpeakText(t);
    socket.emit('wb-read', { action: 'play', text: t.slice(0, 8000), rate: wbReadRate }); // 모두에게 동시 재생
    return;
  }
  triggerToastIfAvailable('텍스트 준비 중…');
  const t = await wbExtractPageText(pg);
  wbPageTextCache.set(pg.id, t);
  if (!t) { triggerToastIfAvailable('읽을 텍스트가 없어요. (이미지형 PDF이거나 빈 페이지)'); return; }
  wbReadOwner = true;
  wbSpeakText(t);
  socket.emit('wb-read', { action: 'play', text: t.slice(0, 8000), rate: wbReadRate });
}

if (wbReadBtn) wbReadBtn.addEventListener('click', wbToggleReading);
if (wbReadSelBtn) wbReadSelBtn.addEventListener('click', () => wbSetTool('readselect'));

// 낭독 속도: 버튼을 누를 때마다 느리게 → 보통 → 빠르게 순환.
const wbRateBtn = document.getElementById('wb-rate-btn');
function wbUpdateRateBtn() {
  if (wbRateBtn) wbRateBtn.textContent = '⏱ ' + wbReadRates[wbReadRateIdx].label;
}
if (wbRateBtn) {
  wbUpdateRateBtn();
  wbRateBtn.addEventListener('click', () => {
    wbReadRateIdx = (wbReadRateIdx + 1) % wbReadRates.length;
    wbReadRate = wbReadRates[wbReadRateIdx].rate;
    wbUpdateRateBtn();
    triggerToastIfAvailable('낭독 속도: ' + wbReadRates[wbReadRateIdx].label);
  });
}

// 다시 듣기: 방금 읽은 내용을 현재 속도로 다시 재생(모두에게 브로드캐스트).
const wbReplayBtn = document.getElementById('wb-replay-btn');
if (wbReplayBtn) wbReplayBtn.addEventListener('click', () => {
  if (!wbTTS) { triggerToastIfAvailable('이 브라우저는 음성 읽기를 지원하지 않아요.'); return; }
  if (!wbLastReadText) { triggerToastIfAvailable('먼저 읽은 내용이 없어요.'); return; }
  wbReadOwner = true;
  wbSpeakText(wbLastReadText);
  socket.emit('wb-read', { action: 'play', text: wbLastReadText.slice(0, 8000), rate: wbReadRate });
});

// ---- 문장별 듣기: 현재 페이지를 문장 단위로 하나씩 재생(이전/다음/반복) ----
const wbSentBtn = document.getElementById('wb-sent-btn');
let wbSentences = [];
let wbSentIdx = 0;
let wbSentBar = null;
let wbSentProg = null;
function wbSplitSentences(text) {
  if (!text) return [];
  return (text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [])
    .map((s) => s.trim()).filter((s) => s.length > 0);
}
function wbUpdateSentProg() {
  if (wbSentProg) wbSentProg.textContent = '문장 ' + (wbSentIdx + 1) + ' / ' + wbSentences.length;
}
function wbPlayCurrentSentence() {
  if (!wbSentences.length) return;
  const t = wbSentences[wbSentIdx];
  wbReadOwner = true;
  wbSpeakText(t);
  socket.emit('wb-read', { action: 'play', text: t.slice(0, 8000), rate: wbReadRate });
  wbUpdateSentProg();
}
function wbSentNext() {
  if (!wbSentences.length) return;
  if (wbSentIdx < wbSentences.length - 1) wbSentIdx++;
  wbPlayCurrentSentence();
}
function wbSentPrev() {
  if (!wbSentences.length) return;
  if (wbSentIdx > 0) wbSentIdx--;
  wbPlayCurrentSentence();
}
function ensureSentenceBar() {
  if (wbSentBar) return wbSentBar;
  const wrap = wbCanvas && wbCanvas.parentElement;
  if (!wrap) return null;
  const bar = document.createElement('div');
  bar.className = 'wb-sentence-bar hidden';
  const mk = (txt, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = txt; b.addEventListener('click', fn); return b; };
  const prog = document.createElement('span'); prog.className = 'prog';
  bar.appendChild(mk('◀ 이전', wbSentPrev));
  bar.appendChild(prog);
  bar.appendChild(mk('다음 ▶', wbSentNext));
  bar.appendChild(mk('🔁 반복', wbPlayCurrentSentence));
  bar.appendChild(mk('✕ 끝내기', wbExitSentenceMode));
  wrap.appendChild(bar);
  wbSentBar = bar; wbSentProg = prog;
  return bar;
}
async function wbStartSentenceMode() {
  if (!wbTTS) { triggerToastIfAvailable('이 브라우저는 음성 읽기를 지원하지 않아요.'); return; }
  const pg = currentPageObj();
  if (!pg || pg.type !== 'pdf') { triggerToastIfAvailable('PDF 페이지에서만 문장 듣기가 돼요.'); return; }
  let text = wbPageTextCache.get(pg.id);
  if (text == null) { text = await wbExtractPageText(pg); wbPageTextCache.set(pg.id, text); }
  const sents = wbSplitSentences(text);
  if (!sents.length) { triggerToastIfAvailable('읽을 문장이 없어요.'); return; }
  wbSentences = sents;
  wbSentIdx = 0;
  ensureSentenceBar();
  if (wbSentBar) wbSentBar.classList.remove('hidden');
  if (wbSentBtn) wbSentBtn.classList.add('active');
  wbPlayCurrentSentence();
}
function wbExitSentenceMode() {
  wbSentences = [];
  wbSentIdx = 0;
  if (wbSentBar) wbSentBar.classList.add('hidden');
  if (wbSentBtn) wbSentBtn.classList.remove('active');
  wbStopReading();
}
if (wbSentBtn) wbSentBtn.addEventListener('click', () => {
  if (wbSentBar && !wbSentBar.classList.contains('hidden')) wbExitSentenceMode(); // 토글: 켜져 있으면 끄기
  else wbStartSentenceMode();
});

// ---- 듣기시험 모드 (선생님은 지문을 보고, 학생 화면은 가리되 소리는 들림) ----
let wbListening = false;
const wbListenBtn = document.getElementById('wb-listen-btn');
let wbListenCover = null;
function ensureListenCover() {
  if (wbListenCover) return wbListenCover;
  const wrap = wbCanvas && wbCanvas.parentElement;
  if (!wrap) return null;
  const el = document.createElement('div');
  el.className = 'wb-listening-cover';
  el.innerHTML = '<div class="big">🎧</div><div>듣기 중입니다</div>'
    + '<div class="sub">지문은 선생님만 볼 수 있어요. 소리에 집중하세요.</div>';
  wrap.appendChild(el);
  wbListenCover = el;
  return el;
}
function setListenCover(on) {
  const el = ensureListenCover();
  if (el) el.classList.toggle('on', !!on);
}
function setListeningMode(on, broadcast) {
  wbListening = !!on;
  if (wbListenBtn) {
    wbListenBtn.classList.toggle('active', wbListening);
    wbListenBtn.textContent = wbListening ? '🎧 듣기 해제' : '🎧 듣기시험';
  }
  if (!isHost) setListenCover(wbListening); // 학생 화면만 가림(선생님은 계속 봄)
  if (broadcast && isHost) socket.emit('listening-mode', { on: wbListening });
}
if (wbListenBtn) wbListenBtn.addEventListener('click', () => {
  if (!isHost) { triggerToastIfAvailable('듣기시험 모드는 선생님만 켤 수 있어요.'); return; }
  setListeningMode(!wbListening, true);
  triggerToastIfAvailable(wbListening ? '듣기시험: 학생 화면을 가렸어요.' : '듣기시험 모드를 해제했어요.');
});
socket.on('listening-mode', ({ on } = {}) => {
  wbListening = !!on;
  if (!isHost) setListenCover(wbListening); // 학생 화면만 가림
});
if (wbTTS && 'onvoiceschanged' in wbTTS) wbTTS.onvoiceschanged = () => {}; // 음성 목록 지연 로드 대비

if (wbCanvas) {
  wbCanvas.addEventListener('pointerdown', wbPointerDown);
  wbCanvas.addEventListener('pointermove', wbPointerMove);
  wbCanvas.addEventListener('pointerup', wbPointerUp);
  wbCanvas.addEventListener('pointercancel', wbPointerUp);
  // pointerleave는 획을 끝내지 않는다. setPointerCapture가 걸려 있으면 펜이
  // 캔버스를 벗어나도 pointerup이 정상적으로 오고, 캡처가 풀리는 경우는
  // lostpointercapture에서 처리한다. (예전엔 leave가 wbPointerUp에 묶여 있어
  //  필기 중 포인터가 잠깐 경계를 벗어났다고 보고되면 획이 끊겼다.)
  wbCanvas.addEventListener('lostpointercapture', (e) => {
    const pid = e && e.pointerId != null ? e.pointerId : null;
    if (pid !== null && pid === wbPenDownId) wbPenDownId = null;
    if (pid === null || wbActivePointerId === null || pid === wbActivePointerId) {
      if (wbDrawing) wbFlushSend(true);
      wbDrawing = false;
      wbCurrentId = null;
      wbActivePointerId = null;
    }
  });

  // iPadOS Safari: 펜을 잠깐 눌러 머무르면 WebKit이 이를 '길게 누르기 → 텍스트
  // 선택 / 콜아웃 메뉴(검색·복사·하이라이트)'로 인식한다. 그 순간 진행 중이던
  // 포인터가 취소되면서 획이 그 자리에서 끊긴다. CSS의 user-select/
  // touch-callout:none 만으로는 iPadOS에서 이 동작을 완전히 막지 못하므로,
  // 아래 이벤트들을 직접 preventDefault 해서 메뉴가 뜨지도, 펜 획이 끊기지도
  // 않게 한다. (gesturestart/change/end는 두 손가락/손바닥 동시 접촉 때 뜨는
  //  사파리 고유 핀치 제스처로, 이것도 펜 포인터를 가로챌 수 있어 함께 막는다.)
  const wbSelectionBlockers = ['contextmenu', 'selectstart',
    'gesturestart', 'gesturechange', 'gestureend'];
  const wbBlockSelection = (e) => { e.preventDefault(); };
  wbSelectionBlockers.forEach((type) => {
    wbCanvas.addEventListener(type, wbBlockSelection);
  });
  // 캔버스 래퍼(양쪽 캔버스를 감싼 영역)에도 걸어, 펜이 캔버스 경계 근처에서
  // 눌렀을 때 부모 쪽에서 콜아웃이 올라오는 경우까지 막는다.
  const wbWrap = wbCanvas.parentElement;
  if (wbWrap) {
    wbWrap.addEventListener('contextmenu', wbBlockSelection);
    wbWrap.addEventListener('selectstart', wbBlockSelection);
  }
}
window.addEventListener('resize', () => { if (wbActive) sizeWhiteboardCanvas(); });

// 캔버스의 '표시 크기'가 바뀔 때마다(툴바 줄바꿈, 배치 전환, 채팅 열고닫기,
// 화면 회전, 스트립 크기조절 등 window 리사이즈가 안 나는 경우 포함) 백킹스토어를
// 즉시 맞춘다. 이걸 안 하면 canvas.width가 옛 값으로 남아 펜 입력과 렌더 좌표의
// 스케일이 어긋나고, 필기가 실제 위치에서 가로로 밀려 찍힌다.
if (typeof ResizeObserver !== 'undefined' && wbCanvas && wbCanvas.parentElement) {
  let wbResizeRaf = 0;
  const wbRO = new ResizeObserver(() => {
    if (!wbActive || wbResizeRaf) return;
    wbResizeRaf = requestAnimationFrame(() => { wbResizeRaf = 0; reflowToolbar(); sizeWhiteboardCanvas(); });
  });
  wbRO.observe(wbCanvas.parentElement);
}



// Runs Google's MediaPipe Selfie Segmentation entirely in the browser: it
// separates you from your background frame-by-frame, and we draw the
// result onto a hidden canvas — you in front, a chosen picture (or a blurred
// version of your real background) behind. canvas.captureStream() turns
// that into a normal video track we can send to peers just like any other.

bgBtn.addEventListener('click', () => {
  bgPanel.classList.toggle('hidden');
});

document.querySelectorAll('.bg-option').forEach((btn) => {
  btn.addEventListener('click', () => {
    setBackground(btn.dataset.bg);
    bgPanel.classList.add('hidden');
  });
});

document.addEventListener('click', (e) => {
  if (!bgPanel.classList.contains('hidden') && !e.target.closest('.bg-picker-wrap')) {
    bgPanel.classList.add('hidden');
  }
  if (!pendingPanel.classList.contains('hidden') && !e.target.closest('.pending-wrap')) {
    pendingPanel.classList.add('hidden');
  }
});

function getSelfieSegmenter() {
  if (selfieSegmenter || selfieSegmenterFailed) return selfieSegmenter;
  if (typeof SelfieSegmentation === 'undefined') {
    selfieSegmenterFailed = true;
    return null;
  }
  try {
    selfieSegmenter = new SelfieSegmentation({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`,
    });
    selfieSegmenter.setOptions({ modelSelection: 1 });
    selfieSegmenter.onResults(onSegmentationResults);
  } catch (e) {
    selfieSegmenterFailed = true;
    selfieSegmenter = null;
  }
  return selfieSegmenter;
}

function onSegmentationResults(results) {
  const w = bgCanvas.width, h = bgCanvas.height;
  bgCtx.save();
  bgCtx.clearRect(0, 0, w, h);

  // 1) Draw the segmentation mask, then keep only the "person" pixels of
  //    the live camera frame (source-in = intersect with existing alpha).
  bgCtx.drawImage(results.segmentationMask, 0, 0, w, h);
  bgCtx.globalCompositeOperation = 'source-in';
  bgCtx.drawImage(results.image, 0, 0, w, h);

  // 2) Fill everything else (destination-over = draw behind what's there)
  //    with either a blurred version of the real background or a picture.
  bgCtx.globalCompositeOperation = 'destination-over';
  if (currentBgMode === 'blur') {
    bgCtx.filter = 'blur(14px)';
    bgCtx.drawImage(results.image, 0, 0, w, h);
    bgCtx.filter = 'none';
  } else {
    const img = bgImageCache[currentBgMode];
    if (img && img.complete && img.naturalWidth > 0) {
      bgCtx.drawImage(img, 0, 0, w, h);
    } else {
      bgCtx.fillStyle = '#1a1b20';
      bgCtx.fillRect(0, 0, w, h);
    }
  }
  bgCtx.restore();
}

async function processSegmentationFrame() {
  if (currentBgMode === 'none') return; // loop stops itself
  const segmenter = getSelfieSegmenter();
  if (segmenter && bgSourceVideo.readyState >= 2) {
    try { await segmenter.send({ image: bgSourceVideo }); } catch (e) { /* skip a frame on hiccup */ }
  }
  vbgRafId = requestAnimationFrame(processSegmentationFrame);
}

async function setBackground(mode) {
  // 파이프라인이 살아 있는지 vbgStream 트랙의 readyState로 판단한다. 재접속 등으로
  // 스트림이 죽었으면, 같은 배경을 다시 눌러도(또는 자동 복구 시) 다시 세우게 한다.
  const alive = !!(vbgStream && vbgStream.getVideoTracks().some((t) => t.readyState === 'live'));
  if (mode === currentBgMode && (mode === 'none' || alive)) return;

  if (mode !== 'none' && getSelfieSegmenter() === null) {
    triggerToastIfAvailable('⚠️ 이 브라우저에서는 배경 기능을 사용할 수 없어요.');
    return;
  }

  currentBgMode = mode;
  updateBgSelectionUI();

  if (mode === 'none') {
    stopVirtualBackgroundLoop();
  } else if (!alive) {
    // 최초 켜기이거나, 재접속으로 끊긴 파이프라인 → 완전히 새로 세운다.
    stopVirtualBackgroundLoop();
    startVirtualBackgroundLoop();
  }
  // (파이프라인이 살아 있으면 루프는 그대로 두고 currentBgMode만 바뀌어, 다음
  //  프레임부터 새 배경이 그려진다 — 배경끼리 전환은 매끄럽게 유지된다.)

  // Don't touch the outgoing track while screen-sharing — it'll pick up
  // the virtual background automatically the next time screen share stops.
  if (!sharingScreen) {
    applyOutgoingVideoToAllPeers();
    updateLocalPreview();
  }
}

function startVirtualBackgroundLoop() {
  if (!localStream) return;
  bgSourceVideo.srcObject = localStream;
  bgSourceVideo.play().catch(() => {});
  vbgStream = bgCanvas.captureStream(30);
  if (!vbgRafId) processSegmentationFrame();
}

function stopVirtualBackgroundLoop() {
  if (vbgRafId) { cancelAnimationFrame(vbgRafId); vbgRafId = null; }
  if (vbgStream) { vbgStream.getTracks().forEach((t) => t.stop()); vbgStream = null; }
  bgSourceVideo.srcObject = null;
}

function updateBgSelectionUI() {
  document.querySelectorAll('.bg-option').forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.bg === currentBgMode);
  });
}

// ---- Tiny toast helper (used above for background-unavailable warning) --
let toastTimer = null;
function triggerToastIfAvailable(msg) {
  let el = document.getElementById('mini-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mini-toast';
    el.className = 'mini-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

leaveBtn.addEventListener('click', () => {
  socket.emit('leave-room');
  if (window.AudioControls) {
    peerConnections.forEach((_pc, id) => AudioControls.detachRemote(id));
    AudioControls.close();
    AudioControls.hideButton();
  }
  if (sharingScreen) stopScreenShare();
  if (currentBgMode !== 'none') { currentBgMode = 'none'; stopVirtualBackgroundLoop(); updateBgSelectionUI(); }
  peerConnections.forEach((pc) => pc.close());
  peerConnections.clear();
  peerNames.clear();
  activeScreenShareId = null;
  videoGrid.classList.remove('spotlight-mode');
  videoGrid.innerHTML = '';
  cleanupLocalStream();
  chatLog.innerHTML = '';

  isHost = false;
  pendingList = [];
  pendingBtn.classList.add('hidden');
  pendingPanel.classList.add('hidden');
  pendingPanel.innerHTML = '';
  pendingCount.textContent = '0';
  currentRoom = null;

  // Deliberate exit: don't let the reconnect handler pull us back in.
  enteredCall = false;
  lastJoin = null;
  resumeToken = null;
  _prevPendingIds = new Set();

  callScreen.classList.add('hidden');
  joinScreen.classList.remove('hidden');
});

function cleanupLocalStream() {
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
}

// ---- Chat --------------------------------------------------------------
toggleChatBtn.addEventListener('click', () => {
  chatPanel.classList.toggle('hidden');
});

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit('chat-message', { text });
  chatInput.value = '';
});

socket.on('chat-message', ({ name, text, at, from }) => {
  const div = document.createElement('div');
  div.className = 'msg';
  const time = new Date(at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  const who = from === socket.id ? `${name} (나)` : name;
  div.innerHTML = `<span class="who">${escapeHtml(who)}</span>${escapeHtml(text)}<span class="when">${time}</span>`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

window.addEventListener('beforeunload', () => {
  if (currentRoom) socket.emit('leave-room');
});
