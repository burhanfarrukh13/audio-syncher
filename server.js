const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 6e7 // ~60MB, headroom over 50MB local audio files
});

app.use(express.static('public'));

// ================= YouTube -> local audio download =================
// We download the audio once with yt-dlp and treat the result exactly like
// an uploaded file track. This is what actually fixes the multi-device echo:
// file tracks use sample-accurate Web Audio scheduling, which a live YouTube
// iframe embed structurally cannot match (see scheduleStart in app.js).
//
// yt-dlp binary is expected at ./yt-dlp (fetched by the Render build command —
// see render.yaml). It's the standalone PyInstaller build, so no Python
// runtime dependency.
// Render deploy fetches a Linux binary to ./yt-dlp (see render.yaml's buildCommand).
// Locally (Windows/Mac/whatever you're developing on), that file won't exist —
// so fall back to a plain 'yt-dlp' command and let the OS resolve it from PATH.
// That means for LOCAL testing you must install yt-dlp yourself and make sure
// it's on PATH — see the setup note below.
const LOCAL_BINARY = path.join(__dirname, 'yt-dlp');
const YT_DLP_CMD = fs.existsSync(LOCAL_BINARY) ? LOCAL_BINARY : 'yt-dlp';
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

function extractYoutubeId(url) {
  const m = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/.exec(url || '');
  return m ? m[1] : null;
}

function findDownloaded(videoId) {
  return fs.readdirSync(DOWNLOAD_DIR).find((f) => f.startsWith(videoId + '.'));
}

function downloadYoutubeAudio(url, videoId) {
  return new Promise((resolve, reject) => {
    // Already downloaded this video before? Reuse it — don't hit YouTube again.
    const existing = findDownloaded(videoId);
    if (existing) return resolve(path.join(DOWNLOAD_DIR, existing));

    const outTemplate = path.join(DOWNLOAD_DIR, `${videoId}.%(ext)s`);
    const args = [
      url,
      '-f', 'bestaudio[ext=m4a]/bestaudio',
      '--no-playlist',
      '--no-warnings',
      '--max-filesize', '60M', // matches maxHttpBufferSize headroom below
      '-o', outTemplate
    ];
    const proc = spawn(YT_DLP_CMD, args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject); // binary missing / not executable
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr.trim().slice(-400) || `yt-dlp exited with code ${code}`));
      const file = findDownloaded(videoId);
      if (!file) return reject(new Error('Download finished but the output file is missing.'));
      resolve(path.join(DOWNLOAD_DIR, file));
    });
  });
}

// roomCode -> room state
const rooms = {};

// How long we keep a disconnected device's slot "reserved" before treating it
// as really gone. Covers phone-lock / background-tab socket drops, which
// usually reconnect within a few seconds but can take longer on iOS.
const HOST_GRACE_MS = 20000;
const LISTENER_GRACE_MS = 30000;

function makeRoomCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function makeTrackId() {
  return 'trk_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function getRoom(code) {
  return rooms[code];
}

function currentOffset(room) {
  if (!room.isPlaying) return room.offset;
  const elapsed = (Date.now() - room.lastUpdate) / 1000;
  return room.offset + elapsed;
}

function currentTrack(room) {
  if (room.currentIndex < 0 || room.currentIndex >= room.queue.length) return null;
  return room.queue[room.currentIndex];
}

// track metadata safe to send to clients (never includes the raw buffer —
// that only goes out via request-track, on demand)
function trackMeta(room) {
  const t = currentTrack(room);
  if (!t) return null;
  if (t.type === 'file') return { id: t.id, type: 'file', fileName: t.fileName };
  if (t.type === 'youtube') return { id: t.id, type: 'youtube', videoId: t.videoId, title: t.title };
  return null;
}

function queueMeta(room) {
  return room.queue.map((t) => ({
    id: t.id,
    type: t.type,
    fileName: t.type === 'file' ? t.fileName : undefined,
    videoId: t.type === 'youtube' ? t.videoId : undefined,
    title: t.type === 'youtube' ? t.title : undefined
  }));
}

function rosterFor(room) {
  return [...room.clients.entries()].map(([clientId, info], i) => ({
    id: clientId,
    label: `Listener ${i + 1}`,
    connected: info.connected !== false
  }));
}

function broadcastRoster(code) {
  const room = getRoom(code);
  if (!room) return;
  const roster = rosterFor(room);
  io.to(room.hostId).emit('roster', { count: roster.length, listeners: roster });
}

function broadcastQueue(code) {
  const room = getRoom(code);
  if (!room) return;
  io.to(code).emit('queue-changed', { queue: queueMeta(room), currentIndex: room.currentIndex });
}

// ---- Readiness tracking (per current track, listener devices only) ----
function resetReadiness(room, trackId) {
  room.readiness = { trackId, ready: new Set() };
}

function readinessPayload(room) {
  const totalCount = room.clients.size;
  const readyCount = room.readiness
    ? [...room.readiness.ready].filter((cid) => room.clients.has(cid)).length
    : 0;
  return { id: room.readiness ? room.readiness.trackId : null, readyCount, totalCount };
}

function broadcastReadiness(code) {
  const room = getRoom(code);
  if (!room) return;
  io.to(room.hostId).emit('readiness', readinessPayload(room));
}

function setCurrentIndex(room, idx, code) {
  room.currentIndex = idx;
  room.isPlaying = false;
  room.offset = 0;
  room.lastUpdate = Date.now();
  const t = currentTrack(room);
  resetReadiness(room, t ? t.id : null);
  io.to(code).emit('track-changed', trackMeta(room));
  broadcastReadiness(code);
}

io.on('connection', (socket) => {

  socket.on('create-room', (payload, cb) => {
    const clientId = payload && payload.clientId;
    if (!clientId) return cb({ ok: false, error: 'Missing client id.' });
    let code;
    do { code = makeRoomCode(); } while (rooms[code]);
    rooms[code] = {
      hostClientId: clientId,
      hostId: socket.id,
      hostConnected: true,
      hostDisconnectTimer: null,
      queue: [],             // [{id, type:'file', fileName, buffer} | {id, type:'youtube', videoId, title}]
      currentIndex: -1,
      clients: new Map(),    // clientId -> { socketId, joinedAt, connected, disconnectTimer }
      isPlaying: false,
      offset: 0,
      lastUpdate: Date.now(),
      readiness: { trackId: null, ready: new Set() }
    };
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.isHost = true;
    socket.data.clientId = clientId;
    cb({ ok: true, roomCode: code });
  });

  socket.on('join-room', ({ code, clientId }, cb) => {
    const room = getRoom(code);
    if (!room) return cb({ ok: false, error: 'Room not found. Check the code.' });
    if (!clientId) return cb({ ok: false, error: 'Missing client id.' });
    room.clients.set(clientId, { socketId: socket.id, joinedAt: Date.now(), connected: true, disconnectTimer: null });
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.isHost = false;
    socket.data.clientId = clientId;
    cb({
      ok: true,
      roomCode: code,
      queue: queueMeta(room),
      currentIndex: room.currentIndex,
      track: trackMeta(room),
      isPlaying: room.isPlaying,
      offset: currentOffset(room)
    });
    broadcastRoster(code);
    broadcastReadiness(code);
    socket.to(code).emit('chat-message', { sender: 'System', text: 'A listener joined.', ts: Date.now() });
  });

  // Reclaims a host or listener slot after a socket reconnect (phone lock,
  // background tab kill, or a fully reloaded/discarded tab restoring from
  // sessionStorage). Does NOT announce "joined" in chat — this is a
  // continuation of an existing session, not a new one.
  socket.on('rejoin', ({ roomCode, clientId, wantHost }, cb) => {
    const room = getRoom(roomCode);
    if (!room || !clientId) return cb({ ok: false, error: 'Room no longer exists.' });

    if (wantHost) {
      if (room.hostClientId !== clientId) {
        return cb({ ok: false, error: 'Host slot is owned by a different session.' });
      }
      if (room.hostDisconnectTimer) { clearTimeout(room.hostDisconnectTimer); room.hostDisconnectTimer = null; }
      room.hostId = socket.id;
      room.hostConnected = true;
      socket.join(roomCode);
      socket.data.roomCode = roomCode;
      socket.data.isHost = true;
      socket.data.clientId = clientId;
      cb({
        ok: true,
        roomCode,
        isHost: true,
        queue: queueMeta(room),
        currentIndex: room.currentIndex,
        track: trackMeta(room),
        isPlaying: room.isPlaying,
        offset: currentOffset(room),
        listeners: rosterFor(room)
      });
      broadcastRoster(roomCode);
      broadcastReadiness(roomCode);
      return;
    }

    const entry = room.clients.get(clientId);
    if (!entry) return cb({ ok: false, error: 'No previous session found for this device.' });
    if (entry.disconnectTimer) { clearTimeout(entry.disconnectTimer); entry.disconnectTimer = null; }
    entry.socketId = socket.id;
    entry.connected = true;
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.isHost = false;
    socket.data.clientId = clientId;
    cb({
      ok: true,
      roomCode,
      isHost: false,
      queue: queueMeta(room),
      currentIndex: room.currentIndex,
      track: trackMeta(room),
      isPlaying: room.isPlaying,
      offset: currentOffset(room)
    });
    broadcastRoster(roomCode);
    broadcastReadiness(roomCode);
  });

  // ---- Queue management (host-only) ----
  socket.on('queue-add', ({ roomCode, item }, cb) => {
    const room = getRoom(roomCode);
    if (!room || room.hostId !== socket.id) return cb && cb({ ok: false });
    if (!item || (item.type !== 'file' && item.type !== 'youtube')) {
      return cb && cb({ ok: false, error: 'Bad queue item.' });
    }
    const track = { id: makeTrackId(), type: item.type };
    if (item.type === 'file') {
      if (!item.buffer || !item.fileName) return cb && cb({ ok: false, error: 'Missing file data.' });
      track.fileName = item.fileName;
      track.buffer = Buffer.from(item.buffer);
    } else {
      if (!item.videoId) return cb && cb({ ok: false, error: 'Missing videoId.' });
      track.videoId = item.videoId;
      track.title = item.title || 'YouTube video';
    }
    room.queue.push(track);
    const wasEmpty = room.currentIndex === -1;
    broadcastQueue(roomCode);
    if (wasEmpty) setCurrentIndex(room, 0, roomCode);
    cb && cb({ ok: true, id: track.id });
  });

  socket.on('queue-add-youtube', ({ roomCode, url }, cb) => {
    const room = getRoom(roomCode);
    if (!room || room.hostId !== socket.id) return cb && cb({ ok: false });
    const videoId = extractYoutubeId(url);
    if (!videoId) return cb && cb({ ok: false, error: 'Could not read a video ID from that URL.' });

    cb && cb({ ok: true }); // ack immediately — real result comes via 'download-status'
    io.to(roomCode).emit('download-status', { status: 'downloading', videoId });

    downloadYoutubeAudio(url, videoId)
      .then((filePath) => {
        const buffer = fs.readFileSync(filePath);
        const track = { id: makeTrackId(), type: 'file', fileName: path.basename(filePath), buffer };
        room.queue.push(track);
        const wasEmpty = room.currentIndex === -1;
        broadcastQueue(roomCode);
        if (wasEmpty) setCurrentIndex(room, 0, roomCode);
        io.to(roomCode).emit('download-status', { status: 'done', videoId });
      })
      .catch((err) => {
        io.to(roomCode).emit('download-status', { status: 'error', videoId, error: err.message });
      });
  });

  socket.on('queue-remove', ({ roomCode, id }, cb) => {
    const room = getRoom(roomCode);
    if (!room || room.hostId !== socket.id) return cb && cb({ ok: false });
    const idx = room.queue.findIndex((t) => t.id === id);
    if (idx === -1) return cb && cb({ ok: false, error: 'Not found.' });
    room.queue.splice(idx, 1);
    if (room.queue.length === 0) {
      room.currentIndex = -1;
      room.isPlaying = false;
      room.offset = 0;
      resetReadiness(room, null);
      io.to(roomCode).emit('track-changed', null);
      broadcastReadiness(roomCode);
    } else if (idx < room.currentIndex) {
      room.currentIndex -= 1; // current track shifted left, still the same track — no track-changed needed
    } else if (idx === room.currentIndex) {
      setCurrentIndex(room, Math.min(idx, room.queue.length - 1), roomCode);
    }
    broadcastQueue(roomCode);
    cb && cb({ ok: true });
  });

  socket.on('queue-reorder', ({ roomCode, fromIndex, toIndex }, cb) => {
    const room = getRoom(roomCode);
    if (!room || room.hostId !== socket.id) return cb && cb({ ok: false });
    if (fromIndex < 0 || fromIndex >= room.queue.length || toIndex < 0 || toIndex >= room.queue.length) {
      return cb && cb({ ok: false, error: 'Bad index.' });
    }
    const wasCurrent = currentTrack(room);
    const [moved] = room.queue.splice(fromIndex, 1);
    room.queue.splice(toIndex, 0, moved);
    if (wasCurrent) room.currentIndex = room.queue.findIndex((t) => t.id === wasCurrent.id);
    broadcastQueue(roomCode);
    cb && cb({ ok: true });
  });

  socket.on('queue-select', ({ roomCode, id }, cb) => {
    const room = getRoom(roomCode);
    if (!room || room.hostId !== socket.id) return cb && cb({ ok: false });
    const idx = room.queue.findIndex((t) => t.id === id);
    if (idx === -1) return cb && cb({ ok: false, error: 'Not found.' });
    setCurrentIndex(room, idx, roomCode);
    cb && cb({ ok: true });
  });

  socket.on('queue-next', ({ roomCode }, cb) => {
    const room = getRoom(roomCode);
    if (!room || room.hostId !== socket.id) return cb && cb({ ok: false });
    if (room.currentIndex >= room.queue.length - 1) return cb && cb({ ok: false, error: 'End of queue.' });
    setCurrentIndex(room, room.currentIndex + 1, roomCode);
    cb && cb({ ok: true });
  });

  socket.on('queue-prev', ({ roomCode }, cb) => {
    const room = getRoom(roomCode);
    if (!room || room.hostId !== socket.id) return cb && cb({ ok: false });
    if (room.currentIndex <= 0) return cb && cb({ ok: false, error: 'Start of queue.' });
    setCurrentIndex(room, room.currentIndex - 1, roomCode);
    cb && cb({ ok: true });
  });

  // Fetch the actual file bytes for the current track (file tracks only —
  // youtube tracks never need this, track-changed/join-room/rejoin carry
  // everything a client needs).
  socket.on('request-track', (roomCode, cb) => {
    const room = getRoom(roomCode);
    const t = room && currentTrack(room);
    if (!room || !t) return cb({ ok: false });
    if (t.type !== 'file') {
      return cb({ ok: true, type: 'youtube', track: trackMeta(room), isPlaying: room.isPlaying, offset: currentOffset(room) });
    }
    cb({
      ok: true,
      type: 'file',
      id: t.id,
      buffer: t.buffer,
      fileName: t.fileName,
      isPlaying: room.isPlaying,
      offset: currentOffset(room)
    });
  });

  socket.on('request-playback-state', (roomCode, cb) => {
    const room = getRoom(roomCode);
    if (!room) return cb({ ok: false });
    cb({ ok: true, isPlaying: room.isPlaying, offset: currentOffset(room), track: trackMeta(room) });
  });

  socket.on('track-ready', ({ roomCode, trackId }) => {
    const room = getRoom(roomCode);
    if (!room || !room.readiness || room.readiness.trackId !== trackId) return; // stale — track already moved on
    const clientId = socket.data.clientId;
    if (!clientId || !room.clients.has(clientId)) return; // only listener devices count toward readiness
    room.readiness.ready.add(clientId);
    broadcastReadiness(roomCode);
  });

  socket.on('play', ({ roomCode, offset }) => {
    const room = getRoom(roomCode);
    if (!room || room.hostId !== socket.id) return; // host-only
    room.isPlaying = true;
    room.offset = offset;
    room.lastUpdate = Date.now();
    io.to(roomCode).emit('play', { offset });
  });

  socket.on('pause', ({ roomCode, offset }) => {
    const room = getRoom(roomCode);
    if (!room || room.hostId !== socket.id) return; // host-only
    room.isPlaying = false;
    room.offset = offset;
    room.lastUpdate = Date.now();
    io.to(roomCode).emit('pause', { offset });
  });

  socket.on('seek', ({ roomCode, offset, resume }) => {
    const room = getRoom(roomCode);
    if (!room || room.hostId !== socket.id) return; // host-only
    room.isPlaying = resume;
    room.offset = offset;
    room.lastUpdate = Date.now();
    io.to(roomCode).emit('seek', { offset, resume });
  });

  socket.on('chat-message', ({ roomCode, text }) => {
    const room = getRoom(roomCode);
    if (!room || !text) return;
    const trimmed = String(text).slice(0, 500);
    io.to(roomCode).emit('chat-message', {
      sender: socket.data.isHost ? 'Host' : 'Listener',
      text: trimmed,
      ts: Date.now()
    });
  });

  // ---- Device management (host-only) ----
  socket.on('kick', ({ roomCode, targetId }) => {
    const room = getRoom(roomCode);
    if (!room || room.hostId !== socket.id) return; // host-only
    const entry = room.clients.get(targetId);
    if (!entry) return;
    if (entry.disconnectTimer) clearTimeout(entry.disconnectTimer);
    const targetSocket = io.sockets.sockets.get(entry.socketId);
    if (targetSocket) {
      targetSocket.emit('kicked');
      targetSocket.disconnect(true);
    }
    room.clients.delete(targetId);
    broadcastRoster(roomCode);
    broadcastReadiness(roomCode);
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const clientId = socket.data.clientId;
    const room = code && rooms[code];
    if (!room) return;

    if (socket.data.isHost) {
      // Only start the grace timer if this disconnecting socket is still the
      // room's live host socket (avoids a stale old socket's disconnect
      // clobbering a host that already reconnected under a new socket id).
      if (room.hostId !== socket.id) return;
      room.hostConnected = false;
      room.hostDisconnectTimer = setTimeout(() => {
        if (rooms[code] !== room) return;
        if (!room.hostConnected) {
          io.to(code).emit('host-left');
          delete rooms[code];
        }
      }, HOST_GRACE_MS);
    } else {
      const entry = room.clients.get(clientId);
      if (!entry || entry.socketId !== socket.id) return;
      entry.connected = false;
      broadcastRoster(code); // let host see "reconnecting…" immediately
      entry.disconnectTimer = setTimeout(() => {
        if (rooms[code] !== room) return;
        const e2 = room.clients.get(clientId);
        if (e2 && !e2.connected) {
          room.clients.delete(clientId);
          broadcastRoster(code);
          broadcastReadiness(code);
        }
      }, LISTENER_GRACE_MS);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  const nets = os.networkInterfaces();
  console.log(`\nSync Audio server running.\n`);
  console.log(`On this laptop, open:  http://localhost:${PORT}`);
  console.log(`On your phone (same WiFi), open one of these:`);
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  http://${net.address}:${PORT}`);
      }
    }
  }
  console.log('');
});
