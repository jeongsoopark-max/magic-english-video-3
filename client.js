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

// State
let localStream = null;      // camera + mic, from getUserMedia
let screenStream = null;     // active only while screen-sharing
let sharingScreen = false;
let myName = '';
let currentRoom = null;
let isHost = false;
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

  if (!roomId) {
    joinError.textContent = '수업 코드를 입력해주세요.';
    return;
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    joinError.textContent = '카메라/마이크 접근을 허용해주세요.';
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
    enterCallScreen(res.peers, res.sharingPeerId);
  });
}

function enterCallScreen(peers, sharingPeerId) {
  joinScreen.classList.add('hidden');
  waitingScreen.classList.add('hidden');
  callScreen.classList.remove('hidden');
  roomLabel.textContent = `수업 코드: ${currentRoom}`;

  activeScreenShareId = sharingPeerId || null;
  addVideoTile('local', 'local', `${myName} (나)`, localStream, true);
  updateParticipantCount();

  pendingBtn.classList.toggle('hidden', !isHost);
  if (!isHost) {
    pendingPanel.classList.add('hidden');
    pendingList = [];
  }

  // Connect out to everyone already in the room.
  peers.forEach((peer) => {
    peerNames.set(peer.id, peer.name);
    createPeerConnection(peer.id, true);
  });
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
socket.on('admission-result', ({ approved, peers, maxSize, reason, sharingPeerId }) => {
  if (approved) {
    isHost = false;
    enterCallScreen(peers, sharingPeerId);
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

screenBtn.addEventListener('click', () => {
  if (sharingScreen) stopScreenShare(); else startScreenShare();
});

async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (err) {
    return; // user cancelled the "choose what to share" picker
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
  screenStream.getVideoTracks()[0].onended = () => stopScreenShare();
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

// ---- Virtual background --------------------------------------------------
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
