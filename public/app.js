const socket = io();

// ---- State ----
let roomCode = null;
let isHost = false;
let audioCtx = null;
let audioBuffer = null;   // decoded, ready to play
let currentSource = null; // currently playing BufferSource

// ---- DOM ----
const el = (id) => document.getElementById(id);
const landing = el('landing');
const hostPanel = el('hostPanel');
const clientPanel = el('clientPanel');
const pulseDot = el('pulseDot');
const globalStatus = el('globalStatus');

function showStatus(msg) { globalStatus.textContent = msg; }

function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

// ---- Playback scheduling (Simplified Fixed Delay) ----
function playWithDelay(delaySec = 1) {
  ensureAudioContext();
  if (!audioBuffer) return;

  stopCurrent();
  currentSource = audioCtx.createBufferSource();
  currentSource.buffer = audioBuffer;
  currentSource.connect(audioCtx.destination);

  // Start playing EXACTLY 1 second from right now using the local audio hardware clock
  currentSource.start(audioCtx.currentTime + delaySec);
  
  // Turn on visual indicator at roughly the same time it starts
  setTimeout(() => {
    pulseDot.classList.add('playing');
  }, delaySec * 1000);
}

function stopCurrent() {
  if (currentSource) {
    try { currentSource.stop(); } catch (e) {}
    currentSource.disconnect();
    currentSource = null;
  }
  pulseDot.classList.remove('playing');
}

// ---- Landing: create or join ----
el('createBtn').addEventListener('click', () => {
  ensureAudioContext();
  socket.emit('create-room', null, ({ ok, roomCode: code }) => {
    if (!ok) return;
    roomCode = code;
    isHost = true;
    el('roomCodeText').textContent = code;
    landing.classList.add('hidden');
    hostPanel.classList.remove('hidden');
    showStatus('Room ready.');
  });
});

el('joinBtn').addEventListener('click', () => {
  const code = el('codeInput').value.trim();
  if (code.length !== 4) {
    el('landingError').textContent = 'Enter the 4-digit code from the host.';
    return;
  }
  ensureAudioContext();
  socket.emit('join-room', code, ({ ok, error, roomCode: rc, hasAudio, fileName }) => {
    if (!ok) {
      el('landingError').textContent = error;
      return;
    }
    roomCode = rc;
    isHost = false;
    el('clientRoomCode').textContent = rc;
    landing.classList.add('hidden');
    clientPanel.classList.remove('hidden');
    showStatus('Connected.');

    if (hasAudio) {
      socket.emit('request-audio', roomCode, async (res) => {
        if (res.ok) await handleIncomingAudio(res.buffer, res.fileName, false);
      });
    }
  });
});

// ---- Host: file upload ----
el('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  el('clientStatus').textContent = 'Loading track…';
  const arrayBuf = await file.arrayBuffer();
  await handleIncomingAudio(arrayBuf.slice(0), file.name, true);
  socket.emit('upload-audio', { roomCode, buffer: arrayBuf, fileName: file.name }, () => {
    el('clientStatus').textContent = 'Track sent to connected devices.';
  });
});

async function handleIncomingAudio(arrayBuf, fileName, isLocalHost) {
  ensureAudioContext();
  try {
    audioBuffer = await audioCtx.decodeAudioData(arrayBuf);
  } catch (err) {
    showStatus('Could not decode that audio file.');
    return;
  }
  if (isHost) {
    el('trackName').textContent = fileName;
    el('playerControls').classList.remove('hidden');
  } else {
    el('clientTrackName').textContent = fileName;
    el('clientWaitMsg').textContent = 'Track loaded. Waiting for host to hit play…';
  }
}

// ---- Host: play / pause ----
el('playBtn').addEventListener('click', () => {
  // Tell all devices in the room (including this one) to trigger playback
  socket.emit('play', roomCode);
  el('playBtn').classList.add('hidden');
  el('pauseBtn').classList.remove('hidden');
});

el('pauseBtn').addEventListener('click', () => {
  socket.emit('pause', roomCode);
  el('pauseBtn').classList.add('hidden');
  el('playBtn').classList.remove('hidden');
});

// ---- Socket listeners (both host & client receive these) ----
socket.on('play', () => {
  if (!audioBuffer) {
    showStatus('Track not finished loading on this device yet.');
    return;
  }
  playWithDelay(1.0); // Wait 1 second (1.0) then play
});

socket.on('pause', () => {
  stopCurrent();
  el('pauseBtn').classList.add('hidden');
  el('playBtn').classList.remove('hidden');
});

socket.on('audio-available', async ({ buffer, fileName }) => {
  await handleIncomingAudio(buffer, fileName, false);
});

socket.on('client-joined', ({ count }) => {
  el('clientStatus').textContent = `${count} device${count === 1 ? '' : 's'} connected.`;
});

socket.on('host-left', () => {
  showStatus('Host disconnected. Refresh to start over.');
  stopCurrent();
});
