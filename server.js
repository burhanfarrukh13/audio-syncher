const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 5e7 // allow up to ~50MB audio files over the socket
});

app.use(express.static('public'));

// roomCode -> { hostId, audioBuffer (Buffer), fileName, clients: Set<socketId> }
const rooms = {};

function makeRoomCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

io.on('connection', (socket) => {

  socket.on('create-room', (_, cb) => {
    let code;
    do { code = makeRoomCode(); } while (rooms[code]);
    rooms[code] = { hostId: socket.id, audioBuffer: null, fileName: null, clients: new Set() };
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.isHost = true;
    cb({ ok: true, roomCode: code });
  });

  socket.on('join-room', (code, cb) => {
    const room = rooms[code];
    if (!room) return cb({ ok: false, error: 'Room not found. Check the code.' });
    room.clients.add(socket.id);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.isHost = false;
    cb({ ok: true, roomCode: code, hasAudio: !!room.audioBuffer, fileName: room.fileName });
    io.to(room.hostId).emit('client-joined', { count: room.clients.size });
  });

  // Host uploads the audio file
  socket.on('upload-audio', ({ roomCode, buffer, fileName }, cb) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return cb && cb({ ok: false });
    room.audioBuffer = Buffer.from(buffer);
    room.fileName = fileName;
    socket.to(roomCode).emit('audio-available', { buffer: room.audioBuffer, fileName });
    cb && cb({ ok: true });
  });

  socket.on('request-audio', (roomCode, cb) => {
    const room = rooms[roomCode];
    if (!room || !room.audioBuffer) return cb({ ok: false });
    cb({ ok: true, buffer: room.audioBuffer, fileName: room.fileName });
  });

  // Simplified play command (no timestamps, just tell everyone to play)
  socket.on('play', (roomCode) => {
    io.to(roomCode).emit('play');
  });

  socket.on('pause', (roomCode) => {
    io.to(roomCode).emit('pause');
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code || !rooms[code]) return;
    if (socket.data.isHost) {
      io.to(code).emit('host-left');
      delete rooms[code];
    } else {
      rooms[code].clients.delete(socket.id);
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