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
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  // { urls: 'turn:YOUR_TURN_HOST:3478', username: 'YOUR_USER', credential: 'YOUR_PASS' },
];

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
const wbEraserBtn = document.getElementById('wb-eraser-btn');
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
const wbZoomInBtn = document.getElementById('wb-zoom-in-btn');
const wbZoomOutBtn = document.getElementById('wb-zoom-out-btn');
const wbZoomFitBtn = document.getElementById('wb-zoom-fit-btn');
const wbZoomIndicator = document.getElementById('wb-zoom-indicator');

// State
let localStream = null;      // camera + mic, from getUserMedia
let screenStream = null;     // active only while screen-sharing
let sharingScreen = false;
let myName = '';
let currentRoom = null;
let isHost = false;
let whiteboardOnlyMode = false;   // this device joined as an iPad drawing tablet
let pendingList = [];              // host-only: people waiting for admission
const peerConnections = new Map(); // socketId -> RTCPeerConnection
const peerNames = new Map();       // socketId -> name

// ---- Spotlight (screen-share) layout state -------------------------------
// null = nobody sharing (normal grid). Otherwise 'local' or a peer's socket
// id — whoever's screen is currently shown large, with everyone else
// shrunk into a thumbnail strip.
let activeScreenShareId = null;

// ---- Spotlight layout preferences (position of the thumbnail strip + its
// size). Persisted in localStorage so the teacher/student doesn't have to
// redo it every class.
let thumbPosition = 'bottom'; // 'bottom' | 'right'
let thumbBottomSize = 140;    // px height of the strip when it's at the bottom
let thumbRightSize = 220;     // px width of the strip when it's on the right

(function loadLayoutPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem('vc_layout_prefs') || 'null');
    if (!saved) return;
    if (saved.position === 'bottom' || saved.position === 'right') thumbPosition = saved.position;
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
    socket.emit('join-room', { roomId, name, requireApproval, whiteboardOnly: true }, (res) => {
      if (!res || !res.ok) {
        joinError.textContent = '입장에 실패했어요. 다시 시도해주세요.';
        currentRoom = null;
        return;
      }
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

  socket.emit('join-room', { roomId, name, requireApproval }, (res) => {
    if (!res.ok) {
      joinError.textContent = res.error === 'room-full'
        ? `이 수업 코드는 이미 ${res.maxSize}명이 참여 중이에요.`
        : '입장에 실패했어요. 다시 시도해주세요.';
      cleanupLocalStream();
      currentRoom = null;
      return;
    }

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

function enterCallScreen(peers, sharingPeerId, whiteboard) {
  joinScreen.classList.add('hidden');
  waitingScreen.classList.add('hidden');
  callScreen.classList.remove('hidden');
  roomLabel.textContent = `수업 코드: ${currentRoom}`;

  activeScreenShareId = sharingPeerId || null;

  if (!whiteboardOnlyMode) {
    addVideoTile('local', 'local', `${myName} (나)`, localStream, true);
  }
  updateParticipantCount();

  pendingBtn.classList.toggle('hidden', !isHost);
  if (!isHost) {
    pendingPanel.classList.add('hidden');
    pendingList = [];
  }

  // Connect out to everyone already in the room (whiteboard device skips this).
  if (!whiteboardOnlyMode) {
    peers.forEach((peer) => {
      peerNames.set(peer.id, peer.name);
      createPeerConnection(peer.id, true);
    });
  }

  // Sync the shared whiteboard: replay existing strokes, and open it if it
  // was already active when we joined.
  if (whiteboard) applyWhiteboardSnapshot(whiteboard);
}

// Host receives this whenever the pending queue changes.
socket.on('pending-list', (list) => {
  pendingList = list || [];
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
socket.on('admission-result', ({ approved, peers, maxSize, reason, sharingPeerId, whiteboard }) => {
  if (approved) {
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
});

socket.on('peer-joined', ({ id, name }) => {
  peerNames.set(id, name);
  // Existing members wait for the new peer's offer; the pc is created
  // lazily in the 'signal' handler when that offer arrives.
  updateParticipantCount();
});

socket.on('peer-left', ({ id }) => {
  const pc = peerConnections.get(id);
  if (pc) pc.close();
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
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      // Leave the tile for now; peer-left will clean it up if they actually left.
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

  tile.appendChild(video);
  tile.appendChild(labelEl);
  videoGrid.appendChild(tile);
  updateGridLayout();
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
    videoGrid.classList.remove('spotlight-mode', 'thumb-right');
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

  const bottomBtn = document.createElement('button');
  bottomBtn.type = 'button';
  bottomBtn.dataset.pos = 'bottom';
  bottomBtn.textContent = '⬇ 아래';

  const rightBtn = document.createElement('button');
  rightBtn.type = 'button';
  rightBtn.dataset.pos = 'right';
  rightBtn.textContent = '➡ 오른쪽';

  [bottomBtn, rightBtn].forEach((btn) => {
    btn.addEventListener('click', () => {
      if (thumbPosition === btn.dataset.pos) return;
      thumbPosition = btn.dataset.pos;
      saveLayoutPrefs();
      updateGridLayout();
    });
  });

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
    const delta = startPos - current;
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
let wbColor = '#111111';
let wbSize = 4;
let wbDrawing = false;
let wbCurrentId = null;
let wbPenSeen = false;
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
  const start = Math.max(1, fromIdx);
  const p0 = toPx(pts[start - 1]);
  wbCtx.beginPath();
  wbCtx.moveTo(p0.x, p0.y);
  for (let i = start; i < pts.length; i++) {
    const p = toPx(pts[i]);
    wbCtx.lineTo(p.x, p.y);
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
function wbPointerDown(e) {
  if (!wbActive) return;
  const pg = currentPageObj();
  if (!pg) return;

  // Pan tool: drag to move the (zoomed) page instead of drawing. Works with any
  // pointer type so a finger can pan even after the Apple Pencil has been used.
  if (wbTool === 'pan') {
    wbPanning = true;
    wbPanStart = { x: e.clientX, y: e.clientY, panX: wbPanX, panY: wbPanY };
    try { wbCanvas.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
    return;
  }

  if (e.pointerType === 'touch' && wbPenSeen) return;
  if (e.pointerType === 'pen') wbPenSeen = true;

  wbDrawing = true;
  wbCurrentId = wbGenId();
  const p = wbNormPoint(e);
  const isEraser = wbTool === 'eraser';
  const isHi = wbTool === 'highlight';
  const stroke = {
    color: wbColor,
    width: isEraser ? Math.max(wbSize * 2.5, 12) : (isHi ? Math.max(wbSize * 3.5, 16) : wbSize),
    erase: isEraser,
    highlight: isHi,
    points: [p],
  };
  pg.strokes.set(wbCurrentId, stroke);
  // Highlight strokes redraw the whole page so the translucent path stays uniform.
  if (isHi) renderCurrentPage(); else drawStrokeSegment(stroke, 0);
  wbQueueSend(p);
  try { wbCanvas.setPointerCapture(e.pointerId); } catch (_) {}
  e.preventDefault();
}

function wbPointerMove(e) {
  // Panning the zoomed page (dragging with the ✋ tool).
  if (wbPanning && wbPanStart) {
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
  if (!wbDrawing || !wbCurrentId) return;
  if (e.pointerType === 'touch' && wbPenSeen) return;
  const pg = currentPageObj();
  const stroke = pg && pg.strokes.get(wbCurrentId);
  if (!stroke) return;
  const events = (e.getCoalescedEvents && e.getCoalescedEvents().length)
    ? e.getCoalescedEvents() : [e];
  const fromIdx = stroke.points.length;
  events.forEach((ev) => {
    const p = wbNormPoint(ev);
    stroke.points.push(p);
    wbQueueSend(p);
  });
  // Highlight strokes redraw the whole page so the translucent path stays uniform.
  if (stroke.highlight) renderCurrentPage(); else drawStrokeSegment(stroke, fromIdx);
  e.preventDefault();
}

function wbPointerUp() {
  if (wbPanning) {
    wbPanning = false;
    wbPanStart = null;
    applyView(true); // final, exact view broadcast to everyone
    return;
  }
  if (!wbDrawing) return;
  wbDrawing = false;
  wbFlushSend(true);
  wbCurrentId = null;
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
  renderCurrentPage();
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
function showWhiteboard() {
  wbActive = true;
  whiteboardPanel.classList.remove('hidden');
  if (callMain) callMain.classList.add('wb-active');
  if (whiteboardBtn) { whiteboardBtn.classList.add('active'); whiteboardBtn.textContent = '필기 닫기'; }
  requestAnimationFrame(() => { sizeWhiteboardCanvas(); renderCurrentPage(); });
}
function hideWhiteboard() {
  wbActive = false;
  whiteboardPanel.classList.add('hidden');
  if (callMain) callMain.classList.remove('wb-active');
  if (whiteboardBtn) { whiteboardBtn.classList.remove('active'); whiteboardBtn.textContent = '필기'; }
}

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

if (wbSharePdfBtn) {
  wbSharePdfBtn.addEventListener('click', async () => {
    if (!wbPages.length) return;
    const jspdfNS = window.jspdf || window.jsPDF;
    const JsPDF = jspdfNS && (jspdfNS.jsPDF || jspdfNS);
    if (!JsPDF) { triggerToastIfAvailable('PDF 기능 로딩 중입니다. 잠시 후 다시 시도해주세요.'); return; }
    try {
      if (wbLoading) { wbLoading.textContent = 'PDF 만드는 중...'; wbLoading.classList.remove('hidden'); }
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
      const stamp = new Date().toISOString().slice(0, 10);
      const blob = doc.output('blob');
      await shareOrDownload(blob, `수업필기_${stamp}.pdf`, '수업 필기');
    } catch (e) {
      triggerToastIfAvailable('PDF를 만들지 못했어요.');
    } finally {
      if (wbLoading) { wbLoading.textContent = 'PDF 불러오는 중...'; wbLoading.classList.add('hidden'); }
    }
  });
}


// Highlight the active tool button (pen / highlighter / eraser / pan).
function wbSetTool(tool) {
  wbTool = tool;
  if (wbPenBtn) wbPenBtn.classList.toggle('active', tool === 'pen');
  if (wbHiBtn) wbHiBtn.classList.toggle('active', tool === 'highlight');
  if (wbEraserBtn) wbEraserBtn.classList.toggle('active', tool === 'eraser');
  if (wbPanBtn) wbPanBtn.classList.toggle('active', tool === 'pan');
  if (wbCanvas) wbCanvas.classList.toggle('wb-pan-cursor', tool === 'pan');
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
if (wbPenBtn) wbPenBtn.addEventListener('click', () => wbSetTool('pen'));
if (wbHiBtn) wbHiBtn.addEventListener('click', () => {
  // A black highlighter looks like a grey smudge, so default to yellow the first
  // time you reach for it from black.
  if (wbColor === '#111111') { wbColor = '#ffd400'; wbSetColorActive(wbColor); }
  wbSetTool('highlight');
});
if (wbEraserBtn) wbEraserBtn.addEventListener('click', () => wbSetTool('eraser'));
if (wbPanBtn) wbPanBtn.addEventListener('click', () => wbSetTool('pan'));
if (wbSizeInput) wbSizeInput.addEventListener('input', () => { wbSize = Number(wbSizeInput.value) || 4; });

// Zoom controls (synced to everyone via applyView/zoomBy).
if (wbZoomInBtn) wbZoomInBtn.addEventListener('click', () => zoomBy(1.25));
if (wbZoomOutBtn) wbZoomOutBtn.addEventListener('click', () => zoomBy(1 / 1.25));
if (wbZoomFitBtn) wbZoomFitBtn.addEventListener('click', () => {
  wbZoom = 1; wbPanX = 0; wbPanY = 0; applyView(true);
});

if (wbCanvas) {
  wbCanvas.addEventListener('pointerdown', wbPointerDown, { passive: false });
  wbCanvas.addEventListener('pointermove', wbPointerMove, { passive: false });
  wbCanvas.addEventListener('pointerup', wbPointerUp);
  wbCanvas.addEventListener('pointercancel', wbPointerUp);
  wbCanvas.addEventListener('pointerleave', wbPointerUp);
  // iPad Safari: stop a pen stroke from turning into a text selection (the
  // purple highlight) or a long-press copy/translate menu.
  wbCanvas.addEventListener('selectstart', (e) => e.preventDefault());
  wbCanvas.addEventListener('contextmenu', (e) => e.preventDefault());
  wbCanvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
}
window.addEventListener('resize', () => { if (wbActive) sizeWhiteboardCanvas(); });



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
  if (mode === currentBgMode) return;

  if (mode !== 'none' && getSelfieSegmenter() === null) {
    triggerToastIfAvailable('⚠️ 이 브라우저에서는 배경 기능을 사용할 수 없어요.');
    return;
  }

  const startingFromNone = currentBgMode === 'none';
  currentBgMode = mode;
  updateBgSelectionUI();

  if (mode === 'none') {
    stopVirtualBackgroundLoop();
  } else {
    if (startingFromNone) startVirtualBackgroundLoop();
  }

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
