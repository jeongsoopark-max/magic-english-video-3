// server.js — signaling server for the small-scale video classroom
//
// Responsibilities:
//   1. Serve the static client (public/).
//   2. Relay WebRTC signaling messages (offer/answer/ICE) between peers
//      in the same room. The server never touches audio/video media —
//      that flows directly peer-to-peer once the connection is set up.
//   3. Track who is in each room and enforce a max room size.
//   4. Relay lightweight text chat messages within a room.
//   5. Optional "waiting room": whoever joins a room first (when nobody is
//      in it) becomes that room's host for as long as they stay connected.
//      If they turned on approval, later joiners sit in a pending queue
//      until the host admits or denies them.

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MAX_ROOM_SIZE = 10; // small group class ceiling for mesh WebRTC

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });

const MAX_PDF_BYTES = 25 * 1024 * 1024; // 25 MB cap per upload

// Teacher uploads a PDF for a room (raw binary body). Stored in memory and
// served back to every participant, who each render it locally with PDF.js.
app.post('/upload-pdf/:roomId', express.raw({ type: 'application/pdf', limit: MAX_PDF_BYTES }), (req, res) => {
  const roomId = req.params.roomId;
  if (!roomId || !rooms.has(roomId)) {
    return res.status(404).json({ ok: false, error: 'no-such-room' });
  }
  if (!req.body || !req.body.length) {
    return res.status(400).json({ ok: false, error: 'empty' });
  }
  const pdfId = 'pdf-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  let pdfs = roomPdfs.get(roomId);
  if (!pdfs) { pdfs = new Map(); roomPdfs.set(roomId, pdfs); }
  pdfs.set(pdfId, { buffer: Buffer.from(req.body), contentType: 'application/pdf' });
  res.json({ ok: true, pdfId });
});

// Any participant fetches a room's PDF to render it.
app.get('/room-pdf/:roomId/:pdfId', (req, res) => {
  const pdfs = roomPdfs.get(req.params.roomId);
  const entry = pdfs && pdfs.get(req.params.pdfId);
  if (!entry) return res.status(404).send('not found');
  res.set('Content-Type', entry.contentType);
  res.set('Cache-Control', 'no-store');
  res.send(entry.buffer);
});

// ---------------------------------------------------------------------------
// Server-side teacher admin: password check + shared class/link config.
//
// The password lives in an environment variable (ADMIN_PASSWORD) so it is never
// shipped to the browser and can't be read from page source. Login is verified
// on the server, which hands back a short-lived signed token. The editable
// config (class links + global links) is stored in config.json and served to
// every visitor, so a change made by the teacher reaches ALL student devices.
//
// NOTE on Render's Free tier: the filesystem is ephemeral, so config.json edits
// made at runtime survive until the service restarts / spins down / redeploys.
// For permanent changes, edit the committed config.json (or use a paid plan
// with a persistent disk). The links rarely change, so this is usually fine.
// ---------------------------------------------------------------------------
const fs = require('fs');
const crypto = require('crypto');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'magic777';
const ADMIN_SECRET = process.env.ADMIN_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000; // teacher stays logged in for 8 hours
const CONFIG_PATH = path.join(__dirname, 'config.json');

const DEFAULT_CONFIG = {
  classes: {
    basic:        { meetLink: 'class.html?room=basic',        playlistLink: 'https://drive.google.com/drive/folders/1RTTcFvRGGNEUFSi0VLXkin-GarBw9hid', driveLink: 'https://drive.google.com/drive/folders/12iMQnFsQagQnPVW7Q2RcISGCaOwSMQod?usp=drive_link' },
    grammar:      { meetLink: 'class.html?room=grammar',      playlistLink: 'https://drive.google.com/drive/folders/1PX-DM6vB9Mugq7hYTW-XDHsoyViikIho', driveLink: 'https://drive.google.com/drive/folders/1sJplWPPBv0F2FSmq7TWEZVDJPBh6v-L9?usp=drive_link' },
    intermediate: { meetLink: 'class.html?room=intermediate', playlistLink: 'https://drive.google.com/drive/folders/13Di9NJJGKJTD2lHsS95RN5psvb7U6RaY', driveLink: 'https://drive.google.com/drive/folders/1vNuffBohWAwdWav4nFpoW2xLHI2pmAY_?usp=drive_link' },
    advanced:     { meetLink: 'class.html?room=advanced',     playlistLink: 'https://drive.google.com/drive/folders/1hq-gLoaTmssCxR_bryueuXijGMTCsR6W', driveLink: 'https://drive.google.com/drive/folders/1DGvWoUFCf367Dw21llcwDCy2dNt0P_uS?usp=drive_link' },
    private:      { meetLink: 'class.html?room=private',       playlistLink: 'https://drive.google.com/drive/folders/1hK_9ud_KU77UJ3M9HpD7rM7lHxYCDiLg', driveLink: 'https://drive.google.com/drive/folders/19LOEvdvTW0gPH6jd3Sin_wB59lmi4_qn?usp=drive_link' }
  },
  globals: {
    vocab: 'https://magic-vocabulary-sjlherfhfppdwp3tgvppqe.streamlit.app/',
    exam: 'https://drive.google.com/drive/folders/12m1z1Y64CLA27nGrwpDsW8eMNz62VvD8',
    studentForm: 'https://forms.gle/1FvJroxUVWzswa5v9',
    adminFormFolder: 'https://drive.google.com/drive/folders/1HuUKm9223tywPEbtooe33A4-8BQdF0L_'
  }
};
const CLASS_KEYS = Object.keys(DEFAULT_CONFIG.classes);
const GLOBAL_KEYS = Object.keys(DEFAULT_CONFIG.globals);

// Keep only known keys, force strings, cap length; fall back to defaults.
function sanitizeConfig(input) {
  const clean = (v, def) => (typeof v === 'string' ? v.trim().slice(0, 2000) : def);
  const out = { classes: {}, globals: {} };
  CLASS_KEYS.forEach((k) => {
    const src = (input && input.classes && input.classes[k]) || {};
    const def = DEFAULT_CONFIG.classes[k];
    out.classes[k] = {
      meetLink: clean(src.meetLink, def.meetLink),
      playlistLink: clean(src.playlistLink, def.playlistLink),
      driveLink: clean(src.driveLink, def.driveLink)
    };
  });
  GLOBAL_KEYS.forEach((k) => {
    const src = (input && input.globals) || {};
    out.globals[k] = clean(src[k], DEFAULT_CONFIG.globals[k]);
  });
  return out;
}

function loadConfig() {
  try { return sanitizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))); }
  catch (e) { return JSON.parse(JSON.stringify(DEFAULT_CONFIG)); }
}
function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); return true; }
  catch (e) { console.error('config save failed:', e.message); return false; }
}
let liveConfig = loadConfig();

// Minimal signed token (HMAC) so we don't need extra dependencies.
function signToken() {
  const payload = 'admin.' + (Date.now() + TOKEN_TTL_MS);
  const sig = crypto.createHmac('sha256', ADMIN_SECRET).update(payload).digest('hex');
  return payload + '.' + sig;
}
function verifyToken(token) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const payload = parts[0] + '.' + parts[1];
  const expected = crypto.createHmac('sha256', ADMIN_SECRET).update(payload).digest('hex');
  const a = Buffer.from(parts[2]); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Date.now() < Number(parts[1]);
}
function passwordMatches(pw) {
  const a = Buffer.from(typeof pw === 'string' ? pw : '');
  const b = Buffer.from(ADMIN_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.use(express.json({ limit: '64kb' }));

// Public: every visitor loads the shared link config on page load.
app.get('/api/config', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(liveConfig);
});

// Teacher login → verify password on the server, return a short-lived token.
app.post('/api/admin/login', (req, res) => {
  const ok = passwordMatches(req.body && req.body.password);
  setTimeout(() => {                      // small delay slows brute-forcing
    if (ok) res.json({ ok: true, token: signToken() });
    else res.status(401).json({ ok: false, error: 'bad-password' });
  }, ok ? 0 : 400);
});

// Teacher save → requires a valid token; writes the shared config for everyone.
app.post('/api/admin/config', (req, res) => {
  if (!verifyToken(req.body && req.body.token)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  liveConfig = sanitizeConfig(req.body && req.body.config);
  const persisted = saveConfig(liveConfig);
  res.json({ ok: true, config: liveConfig, persisted });
});

app.use(express.static(path.join(__dirname, 'public')));

// roomId -> Map<socketId, { name }>   (admitted members, i.e. actually in the call)
const rooms = new Map();
// roomId -> socketId of the current host (the first person who opened the room)
const roomHosts = new Map();
// roomId -> { waitingRoomEnabled: boolean }
const roomSettings = new Map();
// roomId -> Map<socketId, { name }>   (asked to join, waiting on the host)
const roomPending = new Map();
// roomId -> socketId of whoever is currently screen-sharing (if anyone)
const roomSharingPeer = new Map();

// ---- Shared multi-page whiteboard --------------------------------------
// Each room's board is an ordered list of PAGES. A page is either blank or
// backed by one page of an uploaded PDF. Every page keeps its own pen strokes
// so handwriting stays put when you flip pages. Late joiners get the whole
// thing (page list + strokes + which page is showing) so their board matches.
//
// roomId -> {
//   active: bool,
//   currentPage: number,
//   pages: [ { id, type:'blank'|'pdf', pdfId?, pageIndex?, aspect, strokes: Map } ],
// }
const roomWhiteboard = new Map();
// roomId -> Map<pdfId, { buffer: Buffer, contentType: string }>
const roomPdfs = new Map();

function getWhiteboard(roomId) {
  let wb = roomWhiteboard.get(roomId);
  if (!wb) {
    wb = { active: false, currentPage: 0, view: { zoom: 1, panX: 0, panY: 0 }, pages: [newBlankPage()] };
    roomWhiteboard.set(roomId, wb);
  }
  return wb;
}

function newBlankPage() {
  return {
    id: 'pg-' + Math.random().toString(36).slice(2, 9),
    type: 'blank',
    aspect: 4 / 3,
    strokes: new Map(),
  };
}

// Serialize the board for sending to a client (strokes as arrays, no Maps).
function whiteboardSnapshot(roomId) {
  const wb = getWhiteboard(roomId);
  return {
    active: wb.active,
    currentPage: wb.currentPage,
    view: wb.view || { zoom: 1, panX: 0, panY: 0 },
    pages: wb.pages.map((pg) => ({
      id: pg.id,
      type: pg.type,
      pdfId: pg.pdfId,
      pageIndex: pg.pageIndex,
      aspect: pg.aspect,
      strokes: Array.from(pg.strokes.values()),
    })),
  };
}

// Lightweight page list (no strokes) for broadcasting structure changes.
function pageListPayload(roomId) {
  const wb = getWhiteboard(roomId);
  return {
    currentPage: wb.currentPage,
    pages: wb.pages.map((pg) => ({
      id: pg.id, type: pg.type, pdfId: pg.pdfId,
      pageIndex: pg.pageIndex, aspect: pg.aspect,
    })),
  };
}


function getRoomMembers(roomId) {
  return rooms.get(roomId) || new Map();
}

function roomSummary(roomId) {
  const members = getRoomMembers(roomId);
  return Array.from(members.entries())
    .filter(([, info]) => !info.whiteboardOnly)
    .map(([id, info]) => ({ id, name: info.name }));
}

// Number of real video participants (excludes the teacher's whiteboard-only
// tablet, which shouldn't count against the mesh size limit or the count).
function videoMemberCount(roomId) {
  const members = getRoomMembers(roomId);
  let n = 0;
  members.forEach((info) => { if (!info.whiteboardOnly) n += 1; });
  return n;
}

function broadcastPendingList(roomId) {
  const hostId = roomHosts.get(roomId);
  if (!hostId) return;
  const pending = roomPending.get(roomId) || new Map();
  const list = Array.from(pending.entries()).map(([id, info]) => ({ id, name: info.name }));
  io.to(hostId).emit('pending-list', list);
}

io.on('connection', (socket) => {
  let joinedRoom = null;   // set once actually admitted into a room
  let pendingRoom = null;  // set while sitting in a room's waiting queue

  socket.on('join-room', ({ roomId, name, requireApproval, whiteboardOnly }, ack) => {
    if (typeof ack !== 'function') return;
    if (!roomId || typeof roomId !== 'string') {
      return ack({ ok: false, error: 'invalid-room' });
    }
    const cleanName = (name || 'Guest').slice(0, 40);
    const wbOnly = !!whiteboardOnly;
    const members = getRoomMembers(roomId);
    const roomIsFresh = members.size === 0 && !roomHosts.has(roomId);

    // First *video* person in an empty room becomes its host and sets the
    // approval policy. A whiteboard-only device (the teacher's tablet) never
    // becomes host — it just joins for drawing.
    if (roomIsFresh && !wbOnly) {
      members.set(socket.id, { name: cleanName });
      rooms.set(roomId, members);
      roomHosts.set(roomId, socket.id);
      roomSettings.set(roomId, { waitingRoomEnabled: !!requireApproval });

      socket.join(roomId);
      joinedRoom = roomId;
      return ack({
        ok: true, peers: [], maxSize: MAX_ROOM_SIZE, isHost: true,
        whiteboard: whiteboardSnapshot(roomId),
      });
    }

    const settings = roomSettings.get(roomId) || { waitingRoomEnabled: false };
    const hostId = roomHosts.get(roomId);

    // Whiteboard-only devices skip the waiting room entirely (it's the
    // teacher's own second device) and join straight away.
    if (settings.waitingRoomEnabled && hostId && !wbOnly) {
      const pending = roomPending.get(roomId) || new Map();
      pending.set(socket.id, { name: cleanName });
      roomPending.set(roomId, pending);
      pendingRoom = roomId;

      ack({ ok: true, waiting: true });
      broadcastPendingList(roomId);
      return;
    }

    if (!wbOnly && videoMemberCount(roomId) >= MAX_ROOM_SIZE) {
      return ack({ ok: false, error: 'room-full', maxSize: MAX_ROOM_SIZE });
    }

    const existingPeers = roomSummary(roomId);
    members.set(socket.id, { name: cleanName, whiteboardOnly: wbOnly });
    rooms.set(roomId, members);

    socket.join(roomId);
    joinedRoom = roomId;

    ack({
      ok: true,
      peers: wbOnly ? [] : existingPeers, // whiteboard device does no WebRTC
      maxSize: MAX_ROOM_SIZE,
      isHost: false,
      whiteboardOnly: wbOnly,
      sharingPeerId: roomSharingPeer.get(roomId) || null,
      whiteboard: whiteboardSnapshot(roomId),
    });

    // Only announce real video participants to the room (so nobody tries to
    // open a WebRTC connection to the whiteboard-only tablet).
    if (!wbOnly) {
      socket.to(roomId).emit('peer-joined', { id: socket.id, name: cleanName });
    }
  });

  // Host approves or denies someone sitting in the waiting queue.
  socket.on('admission-response', ({ targetId, approve }) => {
    if (!joinedRoom || !targetId) return;
    if (roomHosts.get(joinedRoom) !== socket.id) return; // only the host may decide

    const pending = roomPending.get(joinedRoom);
    if (!pending || !pending.has(targetId)) return;
    const info = pending.get(targetId);
    pending.delete(targetId);
    broadcastPendingList(joinedRoom);

    const targetSocket = io.sockets.sockets.get(targetId);

    if (!approve) {
      io.to(targetId).emit('admission-result', { approved: false });
      return;
    }

    const members = getRoomMembers(joinedRoom);
    if (members.size >= MAX_ROOM_SIZE) {
      io.to(targetId).emit('admission-result', { approved: false, reason: 'room-full' });
      return;
    }

    members.set(targetId, { name: info.name });
    rooms.set(joinedRoom, members);
    if (targetSocket) targetSocket.join(joinedRoom);

    const existingPeers = roomSummary(joinedRoom).filter((p) => p.id !== targetId);
    io.to(targetId).emit('admission-result', {
      approved: true,
      peers: existingPeers,
      maxSize: MAX_ROOM_SIZE,
      sharingPeerId: roomSharingPeer.get(joinedRoom) || null,
      whiteboard: whiteboardSnapshot(joinedRoom),
    });
    io.to(joinedRoom).except(targetId).emit('peer-joined', { id: targetId, name: info.name });
  });

  // After a client is admitted (either approved by the host, or auto-admitted
  // when the host left), it calls this from its OWN connection so we can set
  // its per-socket room state. This is essential: admission-response runs in
  // the *host's* socket scope and cannot set the newcomer's `joinedRoom`, so
  // without this the newcomer's WebRTC signals would be dropped and they'd
  // never actually connect ("approved but can't enter").
  socket.on('confirm-admission', ({ roomId } = {}, ack) => {
    const members = getRoomMembers(roomId);
    if (roomId && members.has(socket.id)) {
      joinedRoom = roomId;
      pendingRoom = null;
    }
    if (typeof ack === 'function') ack({ ok: !!joinedRoom });
  });

  // Someone waiting gives up before the host responds.
  socket.on('cancel-wait', () => leavePendingQueue());

  // Someone started or stopped screen sharing — let everyone else in the
  // room know so their UI can put that person's tile in the spotlight.
  socket.on('screen-share', ({ sharing }) => {
    if (!joinedRoom) return;
    if (sharing) {
      roomSharingPeer.set(joinedRoom, socket.id);
    } else if (roomSharingPeer.get(joinedRoom) === socket.id) {
      roomSharingPeer.delete(joinedRoom);
    }
    socket.to(joinedRoom).emit('screen-share-status', { id: socket.id, sharing: !!sharing });
  });

  // --- Shared multi-page whiteboard ---
  // Opening/closing the board (shows it big for everyone, like a spotlight).
  socket.on('wb-open', () => {
    if (!joinedRoom) return;
    getWhiteboard(joinedRoom).active = true;
    io.to(joinedRoom).emit('wb-active', { active: true });
  });
  socket.on('wb-close', () => {
    if (!joinedRoom) return;
    getWhiteboard(joinedRoom).active = false;
    io.to(joinedRoom).emit('wb-active', { active: false });
  });

  function findPage(wb, pageId) {
    return wb.pages.find((p) => p.id === pageId);
  }

  // Append the pages of an uploaded PDF as new boards. The client uploaded the
  // bytes over HTTP first, learned the page count + aspect ratios with PDF.js,
  // and now tells us how to lay them out.
  socket.on('wb-add-pdf', ({ pdfId, pages } = {}) => {
    if (!joinedRoom || !pdfId || !Array.isArray(pages)) return;
    const wb = getWhiteboard(joinedRoom);
    // Drop the initial empty blank page if it's the only thing there and unused.
    if (wb.pages.length === 1 && wb.pages[0].type === 'blank' && wb.pages[0].strokes.size === 0) {
      wb.pages = [];
    }
    pages.slice(0, 100).forEach((p, i) => {
      wb.pages.push({
        id: 'pg-' + Math.random().toString(36).slice(2, 9),
        type: 'pdf',
        pdfId: String(pdfId).slice(0, 40),
        pageIndex: Number(p.pageIndex) || (i + 1),
        aspect: Number(p.aspect) || (3 / 4),
        strokes: new Map(),
      });
    });
    io.to(joinedRoom).emit('wb-pages', pageListPayload(joinedRoom));
  });

  socket.on('wb-add-blank', () => {
    if (!joinedRoom) return;
    const wb = getWhiteboard(joinedRoom);
    wb.pages.push(newBlankPage());
    io.to(joinedRoom).emit('wb-pages', pageListPayload(joinedRoom));
  });

  // Navigate to a page (broadcast so everyone follows the teacher).
  socket.on('wb-page', ({ index } = {}) => {
    if (!joinedRoom) return;
    const wb = getWhiteboard(joinedRoom);
    const n = Number(index);
    if (!Number.isInteger(n) || n < 0 || n >= wb.pages.length) return;
    wb.currentPage = n;
    io.to(joinedRoom).emit('wb-page', { index: n });
  });

  // Zoom / pan the board (broadcast so everyone sees the same region). Stored so
  // late joiners land on the current view too.
  socket.on('wb-view', ({ zoom, panX, panY } = {}) => {
    if (!joinedRoom) return;
    const wb = getWhiteboard(joinedRoom);
    const z = Math.min(4, Math.max(1, Number(zoom) || 1));
    const px = Math.min(1, Math.max(-1, Number(panX) || 0));
    const py = Math.min(1, Math.max(-1, Number(panY) || 0));
    wb.view = { zoom: z, panX: px, panY: py };
    socket.to(joinedRoom).emit('wb-view', wb.view);
  });

  // A drawing update on a specific page. `points` are normalized 0..1 within
  // that page's rectangle so handwriting lands in the same spot everywhere.
  socket.on('wb-stroke', (msg) => {
    if (!joinedRoom || !msg || !msg.id || !msg.pageId || !Array.isArray(msg.points)) return;
    const wb = getWhiteboard(joinedRoom);
    const page = findPage(wb, msg.pageId);
    if (!page) return;
    let stroke = page.strokes.get(msg.id);
    if (!stroke) {
      stroke = {
        id: String(msg.id).slice(0, 60),
        color: typeof msg.color === 'string' ? msg.color.slice(0, 24) : '#111111',
        width: Number(msg.width) || 3,
        erase: !!msg.erase,
        highlight: !!msg.highlight,
        points: [],
      };
      page.strokes.set(stroke.id, stroke);
      if (page.strokes.size > 5000) {
        const oldestKey = page.strokes.keys().next().value;
        page.strokes.delete(oldestKey);
      }
    }
    const incoming = msg.points.slice(0, 500);
    for (const p of incoming) {
      if (p && typeof p.x === 'number' && typeof p.y === 'number') {
        stroke.points.push({ x: p.x, y: p.y });
      }
    }
    socket.to(joinedRoom).emit('wb-stroke', {
      pageId: msg.pageId, id: stroke.id, color: stroke.color, width: stroke.width,
      erase: stroke.erase, highlight: stroke.highlight, points: incoming, done: !!msg.done,
    });
  });

  // Clear one page (or all pages if pageId omitted).
  socket.on('wb-clear', ({ pageId } = {}) => {
    if (!joinedRoom) return;
    const wb = getWhiteboard(joinedRoom);
    if (pageId) {
      const page = findPage(wb, pageId);
      if (page) page.strokes.clear();
    } else {
      wb.pages.forEach((p) => p.strokes.clear());
    }
    io.to(joinedRoom).emit('wb-clear', { pageId: pageId || null });
  });

  // --- WebRTC signaling relay (server just forwards these blind) ---
  socket.on('signal', ({ to, data }) => {
    if (!to || !joinedRoom) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  // --- Simple room chat ---
  socket.on('chat-message', ({ text }) => {
    if (!joinedRoom || !text) return;
    const members = getRoomMembers(joinedRoom);
    const name = members.get(socket.id)?.name || 'Guest';
    const trimmed = String(text).slice(0, 1000);
    io.to(joinedRoom).emit('chat-message', {
      from: socket.id,
      name,
      text: trimmed,
      at: Date.now(),
    });
  });

  socket.on('leave-room', () => leaveCurrentRoom());
  socket.on('disconnect', () => {
    leaveCurrentRoom();
    leavePendingQueue();
  });

  function leavePendingQueue() {
    if (!pendingRoom) return;
    const pending = roomPending.get(pendingRoom);
    if (pending) {
      pending.delete(socket.id);
      broadcastPendingList(pendingRoom);
    }
    pendingRoom = null;
  }

  function leaveCurrentRoom() {
    if (!joinedRoom) return;
    const roomId = joinedRoom;
    const members = getRoomMembers(roomId);
    members.delete(socket.id);

    // If the person leaving was the one screen-sharing, clear that state so
    // remaining participants' UI drops out of spotlight mode.
    if (roomSharingPeer.get(roomId) === socket.id) {
      roomSharingPeer.delete(roomId);
      socket.to(roomId).emit('screen-share-status', { id: socket.id, sharing: false });
    }

    const wasHost = roomHosts.get(roomId) === socket.id;

    if (members.size === 0) {
      // Room is fully empty — reset it so the next joiner starts fresh
      // (and can become host again if they choose to).
      rooms.delete(roomId);
      roomHosts.delete(roomId);
      roomSettings.delete(roomId);
      roomPending.delete(roomId);
      roomSharingPeer.delete(roomId);
      roomWhiteboard.delete(roomId);
      roomPdfs.delete(roomId);
    } else {
      rooms.set(roomId, members);
      if (wasHost) {
        // The host left but others are still on the call. Nobody's left
        // to approve anyone, so open the room up rather than leaving
        // future joiners stuck forever — and let anyone already waiting
        // in immediately.
        roomHosts.delete(roomId);
        roomSettings.set(roomId, { waitingRoomEnabled: false });
        const pending = roomPending.get(roomId);
        if (pending && pending.size > 0) {
          pending.forEach((info, pendingId) => {
            const pendingSocket = io.sockets.sockets.get(pendingId);
            if (!pendingSocket) return;
            members.set(pendingId, { name: info.name });
            pendingSocket.join(roomId);
            io.to(pendingId).emit('admission-result', {
              approved: true,
              peers: roomSummary(roomId).filter((p) => p.id !== pendingId),
              maxSize: MAX_ROOM_SIZE,
              sharingPeerId: roomSharingPeer.get(roomId) || null,
              whiteboard: whiteboardSnapshot(roomId),
            });
          });
          rooms.set(roomId, members);
          roomPending.delete(roomId);
        }
      }
    }

    socket.to(roomId).emit('peer-left', { id: socket.id });
    socket.leave(roomId);
    joinedRoom = null;
  }
});

server.listen(PORT, () => {
  console.log(`Video classroom signaling server listening on http://localhost:${PORT}`);
});
