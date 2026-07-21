const socket = io();

const SCHEDULE_DELAY = 1.0;   // seconds ahead we schedule play/seek so devices land together
const SEEK_STEP = 10;
const YT_CUE_TIMEOUT = 4000;  // fallback if CUED state never fires (some browsers/embeds are flaky)

// ---- Identity / session persistence ----
// clientId is stable for the life of this tab (sessionStorage, not localStorage —
// a fresh tab should not silently inherit someone else's device identity).
function getClientId() {
  let id = sessionStorage.getItem('sync-audio-clientId');
  if (!id) {
    id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('c_' + Date.now().toString(36) + Math.random().toString(36).slice(2));
    sessionStorage.setItem('sync-audio-clientId', id);
  }
  return id;
}
const CLIENT_ID = getClientId();
const SESSION_KEY = 'sync-audio-session';
function saveSession() {
  if (!roomCode) return;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ roomCode, isHost }));
}
function clearSession() { sessionStorage.removeItem(SESSION_KEY); }
function loadSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

// ---- State ----
let roomCode = null;
let isHost = false;
let trackType = null;     // 'file' | 'youtube' | null
let trackLabel = null;    // fileName or youtube title
let currentTrackId = null; // id of the track currently loaded into the player on THIS device

let queue = [];            // mirror of server queue metadata
let queueCurrentIndex = -1;

let audioCtx = null;
let gainNode = null;
let analyser = null;
let audioBuffer = null;
let currentSource = null;

let ytPlayer = null;
let ytReady = false;
let ytPlayerPromise = null;   // memoized — fixes the concurrent-call race
let ytCuedWaiters = [];       // resolved when the player reports CUED for the pending video
let autoplayBlocked = false;

let isPlaying = false;
let playStartCtxTime = 0;
let playStartOffset = 0;
let pendingSeekOffset = null;
let trackDuration = 0;

// ---- DOM ----
const el = (id) => document.getElementById(id);
const landing = el('landing');
const roomPanel = el('roomPanel');
const playerCard = el('playerCard');
const uploadRow = el('uploadRow');
const pulseDot = el('pulseDot');
const globalStatus = el('globalStatus');

function showStatus(msg) { globalStatus.textContent = msg; }

// ================= IndexedDB cache (file tracks only) =================
const DB_NAME = 'sync-audio-cache';
const STORE = 'tracks';

function openCacheDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function cacheSaveTrack(key, name, arrayBuf) {
  try {
    const db = await openCacheDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ fileName: name, buffer: arrayBuf }, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { console.warn('Cache save failed', e); }
}
async function cacheLoadTrack(key) {
  try {
    const db = await openCacheDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) { return null; }
}

// ================= YouTube IFrame API =================
// Loaded lazily — most sessions may never touch YouTube, no reason to pull this
// in on every page load.
let ytApiLoading = null;
function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (ytApiLoading) return ytApiLoading;
  ytApiLoading = new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = () => resolve();
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  });
  return ytApiLoading;
}

// Memoized: every caller — however many, however concurrent — gets the SAME
// promise and the SAME player instance. The old version checked `if (ytPlayer)`
// AFTER an await, so two calls landing before the first constructor finished
// each built their own YT.Player, and callers ended up with an inconsistent
// mix of a raw player object vs. a pending promise.
function ensureYtPlayer() {
  if (ytPlayerPromise) return ytPlayerPromise;
  ytPlayerPromise = loadYouTubeApi().then(() => new Promise((resolve) => {
    ytPlayer = new YT.Player('ytHiddenPlayer', {
      height: '1', width: '1',
      playerVars: { controls: 0, disablekb: 1, playsinline: 1 },
      events: {
        onReady: () => { ytReady = true; resolve(ytPlayer); },
        onStateChange: onYtStateChange,
        onError: onYtError
      }
    });
  }));
  return ytPlayerPromise;
}

const YT_ERROR_MESSAGES = {
  2: 'That YouTube link looks invalid.',
  5: 'This video can\u2019t be played in an embedded player.',
  100: 'Video not found \u2014 it may have been removed or made private.',
  101: 'The video owner has disabled playback on other sites.',
  150: 'The video owner has disabled playback on other sites.'
};
function onYtError(e) {
  const msg = YT_ERROR_MESSAGES[e.data] || 'YouTube playback error.';
  showStatus(msg);
  if (isHost) showStatus(msg + ' Try a different video.');
}

function onYtStateChange(e) {
  if (e.data === YT.PlayerState.CUED) {
    const waiters = ytCuedWaiters; ytCuedWaiters = [];
    waiters.forEach((r) => r());
  }
  if (e.data === YT.PlayerState.PLAYING) {
    autoplayBlocked = false;
    hideAutoplayPrompt();
  }
  // Autoplay-block: if this device wants to be playing but YouTube refuses to
  // start (common on devices that never had a direct tap), it drops back to
  // UNSTARTED instead of throwing. Surface a real "tap to enable" prompt
  // instead of failing silently.
  if (e.data === YT.PlayerState.UNSTARTED && isPlaying && !autoplayBlocked) {
    autoplayBlocked = true;
    showAutoplayPrompt();
  }
}

function waitForYtCued() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    ytCuedWaiters.push(finish);
    setTimeout(finish, YT_CUE_TIMEOUT); // don't hang the readiness signal forever
  });
}

function showAutoplayPrompt() {
  showStatus('Playback blocked by the browser.');
  el('autoplayPrompt').classList.remove('hidden');
}
function hideAutoplayPrompt() {
  el('autoplayPrompt').classList.add('hidden');
}
el('autoplayPromptBtn').addEventListener('click', () => {
  hideAutoplayPrompt();
  autoplayBlocked = false;
  ensureAudioContext();
  if (trackType === 'youtube' && ytPlayer) {
    ytPlayer.playVideo();
  } else if (trackType === 'file') {
    scheduleStart(getPosition(), 0);
  }
});

function extractYoutubeId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  // bare 11-char ID pasted directly
  if (/^[A-Za-z0-9_-]{11}$/.test(url.trim())) return url.trim();
  return null;
}

// ================= Web Audio engine (file tracks) =================
function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    gainNode = audioCtx.createGain();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 128;
    gainNode.connect(analyser);
    analyser.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
}

function stopSource() {
  if (currentSource) {
    try { currentSource.stop(); } catch (e) {}
    try { currentSource.disconnect(); } catch (e) {}
    currentSource = null;
  }
}

// ================= Unified playback control (branches by trackType) =================
const YT_MIN_SCHEDULE_DELAY = 2.2; // YouTube needs real lead time: seekTo()+playVideo() latency
                                    // varies per device (buffering/network), unlike Web Audio's
                                    // sample-accurate scheduling for local files. This is the
                                    // floor we bump any requested delay up to for youtube tracks.
const YT_DRIFT_CHECK_INTERVAL = 2000; // ms between drift checks while a youtube track plays
const YT_DRIFT_THRESHOLD = 0.25;      // seconds of drift we tolerate before silently correcting
let ytDriftTimer = null;

function stopYtDriftCorrection() {
  if (ytDriftTimer) { clearInterval(ytDriftTimer); ytDriftTimer = null; }
}
function startYtDriftCorrection() {
  stopYtDriftCorrection();
  ytDriftTimer = setInterval(() => {
    if (trackType !== 'youtube' || !isPlaying || !ytPlayer || typeof ytPlayer.getCurrentTime !== 'function') return;
    const expected = playStartOffset + (performance.now() / 1000 - playStartCtxTime);
    let actual;
    try { actual = ytPlayer.getCurrentTime(); } catch (e) { return; }
    if (Math.abs(actual - expected) > YT_DRIFT_THRESHOLD) {
      try { ytPlayer.seekTo(expected, true); } catch (e) {}
    }
  }, YT_DRIFT_CHECK_INTERVAL);
}

function scheduleStart(offset, delaySec) {
  if (trackType === 'file') {
    ensureAudioContext();
    if (!audioBuffer) return;
    stopSource();
    const clamped = Math.max(0, Math.min(offset, audioBuffer.duration - 0.05));
    currentSource = audioCtx.createBufferSource();
    currentSource.buffer = audioBuffer;
    currentSource.connect(gainNode);
    currentSource.start(audioCtx.currentTime + delaySec, clamped);
    playStartCtxTime = audioCtx.currentTime + delaySec;
    playStartOffset = clamped;

    isPlaying = true;
    setTimeout(() => {
      pulseDot.classList.add('playing');
      setDiscSpinning(true);
      updatePlayPauseIcon();
    }, Math.max(0, delaySec * 1000));

  } else if (trackType === 'youtube' && ytPlayer) {
    // Give it real lead time, and seek NOW instead of at T-0 — that way the
    // re-buffering latency happens during the countdown, not at the moment
    // that determines whether devices sound in sync.
    const ytDelay = Math.max(delaySec, YT_MIN_SCHEDULE_DELAY);
    playStartOffset = offset;
    playStartCtxTime = performance.now() / 1000 + ytDelay;
    try { ytPlayer.seekTo(offset, true); } catch (e) {}
    try { ytPlayer.pauseVideo(); } catch (e) {} // stay paused-but-buffered until T-0

    isPlaying = true;
    setTimeout(() => {
      pulseDot.classList.add('playing');
      setDiscSpinning(true);
      updatePlayPauseIcon();
      try { ytPlayer.playVideo(); } catch (e) {}
      startYtDriftCorrection();
    }, Math.max(0, ytDelay * 1000));
  } else {
    return;
  }
}

function pauseAt(offset) {
  stopYtDriftCorrection();
  if (trackType === 'file') {
    stopSource();
  } else if (trackType === 'youtube' && ytPlayer) {
    ytPlayer.pauseVideo();
    ytPlayer.seekTo(offset, true);
  }
  playStartOffset = Math.max(0, offset);
  isPlaying = false;
  pulseDot.classList.remove('playing');
  setDiscSpinning(false);
  updatePlayPauseIcon();
}

function getPosition() {
  if (trackType === 'file') {
    if (!audioBuffer) return 0;
    if (!isPlaying) return playStartOffset;
    return Math.max(0, Math.min(playStartOffset + (audioCtx.currentTime - playStartCtxTime), audioBuffer.duration));
  }
  if (trackType === 'youtube' && ytPlayer && ytReady) {
    if (isPlaying && typeof ytPlayer.getCurrentTime === 'function') {
      try { return ytPlayer.getCurrentTime(); } catch (e) { return playStartOffset; }
    }
    return playStartOffset;
  }
  return 0;
}

function updatePlayPauseIcon() {
  el('playPauseBtn').textContent = isPlaying ? '⏸' : '▶';
}

function setDiscSpinning(spinning) {
  el('artWrap').classList.toggle('spinning', spinning);
}

// ================= Room setup =================
el('createBtn').addEventListener('click', () => {
  ensureAudioContext();
  socket.emit('create-room', { clientId: CLIENT_ID }, ({ ok, roomCode: code }) => {
    if (!ok) return;
    enterRoom(code, true);
    saveSession();
  });
});

el('joinBtn').addEventListener('click', () => {
  const code = el('codeInput').value.trim();
  if (code.length !== 4) {
    el('landingError').textContent = 'Enter the 4-digit code from the host.';
    return;
  }
  ensureAudioContext();
  socket.emit('join-room', { code, clientId: CLIENT_ID }, async (res) => {
    if (!res.ok) { el('landingError').textContent = res.error; return; }
    enterRoom(res.roomCode, false);
    saveSession();
    applyQueueUpdate(res.queue, res.currentIndex);
    if (res.track) await activateTrack(res.track, res.isPlaying, res.offset);
  });
});

function enterRoom(code, hostFlag) {
  roomCode = code;
  isHost = hostFlag;
  landing.classList.add('hidden');
  roomPanel.classList.remove('hidden');
  el('roomCodeText').textContent = code;

  if (isHost) {
    uploadRow.classList.remove('hidden');
    el('youtubeRow').classList.remove('hidden');
    el('rosterPanel').classList.remove('hidden');
    el('queuePanel').classList.remove('hidden');
    el('readinessPanel').classList.remove('hidden');
    el('trackNavRow').classList.remove('hidden');
    el('roleHint').textContent = 'You are hosting. Everyone in this room hears/sees what you play.';
  } else {
    el('queuePanel').classList.remove('hidden');
    el('roleHint').textContent = 'Listening mode — playback is controlled by the host.';
    setControlsEnabled(false);
  }
  showStatus('Connected.');
}

function setControlsEnabled(enabled) {
  el('playPauseBtn').disabled = !enabled;
  el('backBtn').disabled = !enabled;
  el('fwdBtn').disabled = !enabled;
  el('progressSlider').disabled = !enabled;
}

// ================= Reconnect / rejoin =================
// Fires on the socket's very first connect AND every subsequent auto-reconnect
// (socket.io keeps retrying under the hood). If sessionStorage has no session,
// this is a no-op — normal fresh landing-page load.
socket.on('connect', () => {
  const session = loadSession();
  if (!session || !session.roomCode) return;
  showStatus('Reconnecting…');
  socket.emit('rejoin', { roomCode: session.roomCode, clientId: CLIENT_ID, wantHost: session.isHost }, async (res) => {
    if (!res || !res.ok) {
      clearSession();
      showStatus(res && res.error ? res.error : 'Could not rejoin — please start again.');
      return;
    }
    enterRoom(res.roomCode, res.isHost);
    applyQueueUpdate(res.queue, res.currentIndex);
    if (res.listeners) renderRoster(res.listeners);
    if (res.track && res.track.id !== currentTrackId) {
      await activateTrack(res.track, res.isPlaying, res.offset);
    } else if (res.track) {
      applyServerState(res.isPlaying, res.offset);
    }
    showStatus('Reconnected.');
  });
});

// Covers the case where the tab was backgrounded/killed hard enough that the
// socket dropped without JS ever running, and also the case where it kept
// running but the AudioContext got suspended by the browser.
function handleForeground() {
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => { if (isPlaying) showAutoplayPrompt(); });
  }
  if (!roomCode) return;
  socket.emit('request-playback-state', roomCode, async (res) => {
    if (!res || !res.ok) return;
    if (res.track && res.track.id !== currentTrackId) {
      await activateTrack(res.track, res.isPlaying, res.offset);
    } else if (res.track) {
      applyServerState(res.isPlaying, res.offset);
    }
  });
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') handleForeground();
});
window.addEventListener('pageshow', handleForeground);

// ================= Loading a track (file, with cache, or youtube) =================
async function activateTrack(track, playing, offset) {
  if (track.type === 'file') {
    const cached = await cacheLoadTrack(track.id);
    if (cached && cached.fileName === track.fileName) {
      el('cacheStatus').textContent = 'Loaded from local cache (no re-download needed).';
      await decodeFileTrack(cached.buffer, track.fileName, track.id);
      applyServerState(playing, offset);
      emitTrackReady(track.id);
      return;
    }
    socket.emit('request-track', roomCode, async (res) => {
      if (!res.ok || res.type !== 'file') return;
      await decodeFileTrack(res.buffer, res.fileName, res.id || track.id);
      cacheSaveTrack(res.id || track.id, res.fileName, res.buffer.slice(0));
      applyServerState(res.isPlaying, res.offset);
      emitTrackReady(res.id || track.id);
    });
  } else if (track.type === 'youtube') {
    await activateYoutubeTrack(track.videoId, track.title, track.id, playing, offset);
    emitTrackReady(track.id);
  }
}

// Guards against staleness: if the host skipped to another track while this
// device was mid-download/mid-cue, don't tell the server the OLD track is ready.
function emitTrackReady(trackId) {
  if (!roomCode || trackId !== currentTrackId) return;
  socket.emit('track-ready', { roomCode, trackId });
}

function applyServerState(playing, offset) {
  if (playing) scheduleStart(offset, 0.2);
  else pauseAt(offset);
  refreshProgressUI();
}

async function decodeFileTrack(arrayBuf, name, id) {
  ensureAudioContext();
  trackType = 'file';
  trackLabel = name;
  currentTrackId = id;
  try {
    audioBuffer = await audioCtx.decodeAudioData(arrayBuf.slice(0));
  } catch (err) {
    showStatus('Could not decode that audio file.');
    return;
  }
  if (id !== currentTrackId) return; // track changed again while we were decoding
  trackDuration = audioBuffer.duration;
  finishTrackActivation(name, null);
}

async function activateYoutubeTrack(videoId, title, id, playing, offset) {
  await ensureYtPlayer();
  stopYtDriftCorrection();
  trackType = 'youtube';
  trackLabel = title;
  currentTrackId = id;
  audioBuffer = null; // no decoded buffer for youtube — visualizer/bass pulse stay off
  ytPlayer.cueVideoById(videoId);
  trackDuration = 0; // unknown until YT reports it; polled in refreshProgressUI
  finishTrackActivation(title, `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`);
  await waitForYtCued();
  if (id !== currentTrackId) return; // moved on already
  if (typeof playing !== 'undefined') applyServerState(playing, offset || 0);
}

function finishTrackActivation(label, artUrl) {
  el('trackName').textContent = label;
  playerCard.classList.remove('hidden');
  el('artImage').style.backgroundImage = artUrl ? `url('${artUrl}')` : 'none';
  el('visualizer').classList.toggle('hidden', trackType !== 'file');
  if (isHost) setControlsEnabled(true);
}

// ---- Host: add file to queue ----
el('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  showStatus('Adding to queue…');
  const arrayBuf = await file.arrayBuffer();
  socket.emit('queue-add', { roomCode, item: { type: 'file', fileName: file.name, buffer: arrayBuf } }, (res) => {
    showStatus(res && res.ok ? 'Added to queue.' : 'Could not add track.');
  });
  e.target.value = '';
});

// ---- Host: add YouTube URL to queue (server downloads audio, adds as a normal file track) ----
el('loadYtBtn').addEventListener('click', async () => {
  const raw = el('youtubeInput').value.trim();
  if (!raw) return;
  el('ytError').classList.add('hidden');
  showStatus('Downloading audio from YouTube… this can take a few seconds.');
  el('loadYtBtn').disabled = true;

  socket.emit('queue-add-youtube', { roomCode, url: raw }, (res) => {
    if (!res || !res.ok) {
      el('loadYtBtn').disabled = false;
      el('ytError').textContent = (res && res.error) || 'Could not read that URL.';
      el('ytError').classList.remove('hidden');
    }
    // on ok, real completion arrives via the 'download-status' event below
  });
  el('youtubeInput').value = '';
});

socket.on('download-status', ({ status, error }) => {
  el('loadYtBtn').disabled = false;
  if (status === 'downloading') {
    showStatus('Downloading audio from YouTube…');
  } else if (status === 'done') {
    showStatus('Added to queue.');
  } else if (status === 'error') {
    showStatus('Download failed.');
    el('ytError').textContent = error || 'Download failed — the video may be unavailable or restricted.';
    el('ytError').classList.remove('hidden');
  }
});

// ================= Playback controls (host-only) =================
el('playPauseBtn').addEventListener('click', () => {
  if (!isHost || !trackType) return;
  const offset = getPosition();
  if (isPlaying) socket.emit('pause', { roomCode, offset });
  else socket.emit('play', { roomCode, offset });
});

el('backBtn').addEventListener('click', () => seekBy(-SEEK_STEP));
el('fwdBtn').addEventListener('click', () => seekBy(SEEK_STEP));

function seekBy(delta) {
  if (!isHost || !trackType) return;
  const dur = trackType === 'file' ? audioBuffer.duration : (trackDuration || 1e6);
  const target = Math.max(0, Math.min(getPosition() + delta, dur));
  socket.emit('seek', { roomCode, offset: target, resume: isPlaying });
}

el('prevTrackBtn').addEventListener('click', () => {
  if (!isHost) return;
  socket.emit('queue-prev', { roomCode }, (res) => { if (res && !res.ok && res.error) showStatus(res.error); });
});
el('nextTrackBtn').addEventListener('click', () => {
  if (!isHost) return;
  socket.emit('queue-next', { roomCode }, (res) => { if (res && !res.ok && res.error) showStatus(res.error); });
});

const progressSlider = el('progressSlider');
progressSlider.addEventListener('input', () => {
  const dur = trackType === 'file' ? (audioBuffer ? audioBuffer.duration : 0) : trackDuration;
  if (!dur) return;
  const frac = progressSlider.value / 1000;
  pendingSeekOffset = frac * dur;
  el('timeCurrent').textContent = formatTime(pendingSeekOffset);
});
progressSlider.addEventListener('change', () => {
  if (!isHost || pendingSeekOffset === null) return;
  socket.emit('seek', { roomCode, offset: pendingSeekOffset, resume: isPlaying });
  pendingSeekOffset = null;
});

el('volumeSlider').addEventListener('input', (e) => {
  const v = e.target.value / 100;
  if (trackType === 'file') {
    ensureAudioContext();
    if (gainNode) gainNode.gain.value = v;
  } else if (trackType === 'youtube' && ytPlayer) {
    ytPlayer.setVolume(e.target.value);
  }
});

// ================= Socket listeners (sync events) =================
socket.on('play', ({ offset }) => {
  if (!trackType) { showStatus('Track still loading on this device…'); return; }
  scheduleStart(offset, SCHEDULE_DELAY);
});
socket.on('pause', ({ offset }) => pauseAt(offset));
socket.on('seek', ({ offset, resume }) => {
  if (!trackType) return;
  if (resume) scheduleStart(offset, SCHEDULE_DELAY);
  else pauseAt(offset);
});

socket.on('track-changed', async (track) => {
  if (!track) {
    trackType = null;
    currentTrackId = null;
    playerCard.classList.add('hidden');
    el('trackName').textContent = 'No track loaded';
    return;
  }
  await activateTrack(track, false, 0);
});

socket.on('queue-changed', ({ queue: q, currentIndex }) => applyQueueUpdate(q, currentIndex));

socket.on('readiness', ({ readyCount, totalCount }) => {
  if (!isHost) return;
  el('readyCount').textContent = readyCount;
  el('readyTotal').textContent = totalCount;
  const pct = totalCount > 0 ? Math.round((readyCount / totalCount) * 100) : 0;
  el('readinessFill').style.width = pct + '%';
  el('readinessPanel').classList.toggle('hidden', totalCount === 0);
});

socket.on('roster', ({ count, listeners }) => {
  el('clientStatus').textContent = `${count} device${count === 1 ? '' : 's'} connected.`;
  renderRoster(listeners || []);
});

socket.on('kicked', () => {
  clearSession();
  showStatus('The host removed you from the room.');
  stopSource();
  setTimeout(() => location.reload(), 1500);
});

socket.on('host-left', () => {
  clearSession();
  showStatus('Host disconnected. Refresh to start over.');
  stopSource();
});

socket.on('chat-message', ({ sender, text }) => addChatMessage(sender, text));

// ================= Queue (rendered for everyone, controls host-only) =================
function applyQueueUpdate(q, currentIndex) {
  queue = q || [];
  queueCurrentIndex = typeof currentIndex === 'number' ? currentIndex : -1;
  renderQueue();
}

function renderQueue() {
  const box = el('queueList');
  box.innerHTML = '';
  if (queue.length === 0) {
    box.innerHTML = '<p class="hint">Queue is empty.</p>';
    return;
  }
  queue.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'queue-row' + (i === queueCurrentIndex ? ' active' : '');
    const label = document.createElement('span');
    label.className = 'queue-row-label';
    label.textContent = (i === queueCurrentIndex ? '\u25B6 ' : '') + (t.type === 'file' ? t.fileName : t.title);
    row.appendChild(label);

    if (isHost) {
      const actions = document.createElement('div');
      actions.className = 'queue-row-actions';

      if (i !== queueCurrentIndex) {
        const playBtn = document.createElement('button');
        playBtn.className = 'icon-btn queue-mini';
        playBtn.title = 'Play now';
        playBtn.textContent = '▶';
        playBtn.addEventListener('click', () => socket.emit('queue-select', { roomCode, id: t.id }));
        actions.appendChild(playBtn);
      }
      if (i > 0) {
        const upBtn = document.createElement('button');
        upBtn.className = 'icon-btn queue-mini';
        upBtn.title = 'Move up';
        upBtn.textContent = '↑';
        upBtn.addEventListener('click', () => socket.emit('queue-reorder', { roomCode, fromIndex: i, toIndex: i - 1 }));
        actions.appendChild(upBtn);
      }
      if (i < queue.length - 1) {
        const downBtn = document.createElement('button');
        downBtn.className = 'icon-btn queue-mini';
        downBtn.title = 'Move down';
        downBtn.textContent = '↓';
        downBtn.addEventListener('click', () => socket.emit('queue-reorder', { roomCode, fromIndex: i, toIndex: i + 1 }));
        actions.appendChild(downBtn);
      }
      const removeBtn = document.createElement('button');
      removeBtn.className = 'icon-btn queue-mini danger';
      removeBtn.title = 'Remove';
      removeBtn.textContent = '\u2715';
      removeBtn.addEventListener('click', () => socket.emit('queue-remove', { roomCode, id: t.id }));
      actions.appendChild(removeBtn);

      row.appendChild(actions);
    }
    box.appendChild(row);
  });
}

// ================= Device roster (host-only view) =================
function renderRoster(listeners) {
  const box = el('rosterList');
  box.innerHTML = '';
  if (listeners.length === 0) {
    box.innerHTML = '<p class="hint">No listeners yet.</p>';
    return;
  }
  listeners.forEach((l) => {
    const row = document.createElement('div');
    row.className = 'roster-row';
    row.innerHTML = `<span>${l.label}${l.connected === false ? ' <em>(reconnecting…)</em>' : ''}</span>`;
    if (isHost) {
      const btn = document.createElement('button');
      btn.className = 'btn small danger';
      btn.textContent = 'Remove';
      btn.addEventListener('click', () => socket.emit('kick', { roomCode, targetId: l.id }));
      row.appendChild(btn);
    }
    box.appendChild(row);
  });
}

// ================= Chat =================
el('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = el('chatInput');
  const text = input.value.trim();
  if (!text || !roomCode) return;
  input.value = '';
  socket.emit('chat-message', { roomCode, text });
});

function addChatMessage(sender, text) {
  const div = document.createElement('div');
  const isSystem = sender === 'System';
  const isMe = (sender === 'Host' && isHost) || (sender === 'Listener' && !isHost);
  div.className = 'chat-msg' + (isSystem ? ' system' : '') + (isMe ? ' me' : '');
  if (isSystem) div.textContent = text;
  else div.innerHTML = `<span class="sender">${sender}</span>${escapeHtml(text)}`;
  const box = el('chatMessages');
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}
function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ================= Progress, bass pulse, visualizer loop =================
function refreshProgressUI() {
  if (!trackType) return;
  const dur = trackType === 'file' ? (audioBuffer ? audioBuffer.duration : 0)
                                    : (trackDuration || (ytPlayer && ytReady && typeof ytPlayer.getDuration === 'function' ? ytPlayer.getDuration() : 0));
  if (trackType === 'youtube' && dur) trackDuration = dur;
  if (!dur) return;
  const pos = getPosition();
  const frac = Math.max(0, Math.min(pos / dur, 1));
  if (pendingSeekOffset === null) progressSlider.value = Math.round(frac * 1000);
  el('timeCurrent').textContent = formatTime(pos);
  el('timeTotal').textContent = formatTime(dur);
}

function formatTime(sec) {
  if (isNaN(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// Bass-reactive pulse: file tracks only (YouTube's audio graph is inaccessible
// to Web Audio — no analyser data exists for it, so no pulse for YouTube).
function drawVisualizer() {
  requestAnimationFrame(drawVisualizer);
  const canvas = el('visualizer');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const art = el('artWrap');
  if (!analyser || trackType !== 'file' || !isPlaying) {
    art.style.setProperty('--bass-scale', '1');
    art.style.setProperty('--bass-glow', '0');
    return;
  }

  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);

  // Low bins ~= low frequencies ("bass"). fftSize 128 -> 64 bins;
  // first ~5 bins cover roughly 0-350Hz on a typical 44.1kHz source.
  const bassBins = data.slice(0, 5);
  const bassLevel = bassBins.reduce((a, b) => a + b, 0) / bassBins.length / 255;
  art.style.setProperty('--bass-scale', (1 + bassLevel * 0.06).toFixed(3));
  art.style.setProperty('--bass-glow', bassLevel.toFixed(3));

  const bufferLen = analyser.frequencyBinCount;
  const cx = canvas.width / 2, cy = canvas.height / 2;
  const bars = 48;
  for (let i = 0; i < bars; i++) {
    const v = data[i % bufferLen] || 0;
    const len = 10 + (v / 255) * 60;
    const angle = (i / bars) * Math.PI * 2;
    const x1 = cx + Math.cos(angle) * 78;
    const y1 = cy + Math.sin(angle) * 78;
    const x2 = cx + Math.cos(angle) * (78 + len);
    const y2 = cy + Math.sin(angle) * (78 + len);
    ctx.strokeStyle = 'rgba(79, 209, 197, 0.8)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
}

setInterval(refreshProgressUI, 250);
requestAnimationFrame(drawVisualizer);
