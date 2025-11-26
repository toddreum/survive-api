'use strict';
/*
 Production-ready combined server with voxel/chunk support:
 - GET /health
 - POST /create-room
 - POST /support
 - GET /chunk/:cx/:cz (optional REST endpoint for chunks)
 - Serves static frontend from ../frontend/public
 - Socket.IO for realtime joinGame -> joinedRoom
 - Socket.IO voxel events: blockPlace, blockRemove, chunkRequest, pos, shoot, pickup
 - Capture/shield gameplay with block-based shield spawning
 - CORS + socket.io allowed origins read from FRONTEND_ORIGINS / FRONTEND_ORIGIN
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const cors = require('cors');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// CONFIG
const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.resolve(__dirname, 'persist.json');
const FRONTEND_DIR = path.resolve(__dirname, '..', 'frontend', 'public');
const CAPTURE_DISTANCE = parseFloat(process.env.CAPTURE_DISTANCE) || 2.0;
const CAPTURE_HOLD_MS = parseInt(process.env.CAPTURE_HOLD_MS, 10) || 1500;
const SHIELD_DURABILITY = parseInt(process.env.SHIELD_DURABILITY, 10) || 3;

// In-memory chunk storage: Map of "cx,cz" -> chunk data
const chunks = new Map();

// Room state: players, shields, capture timers
const rooms = new Map(); // roomId -> { players: Map(socketId -> playerData), shields: Map(id -> shield), captureTimers: Map }

// Parse allowed origins
function parseAllowedOrigins() {
  const raw = process.env.FRONTEND_ORIGINS || process.env.FRONTEND_ORIGIN || '';
  if (!raw) {
    return [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'https://survive.com',
      'https://www.survive.com'
    ];
  }
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}
const ALLOWED_ORIGINS = parseAllowedOrigins();
console.log('Allowed origins for CORS/socket.io:', ALLOWED_ORIGINS);

// CORS middleware
function corsOptions() {
  return {
    origin: function(origin, callback) {
      // allow non-browser requests with no origin (curl, Postman)
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.indexOf(origin) !== -1) return callback(null, true);
      const msg = `CORS blocked: origin ${origin} not in allow list`;
      console.warn(msg);
      return callback(new Error(msg), false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true
  };
}
app.use(cors(corsOptions()));

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', now: Date.now() });
});

// Create-room
app.post('/create-room', async (req, res) => {
  try {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];

    let store = { invites: {} };
    try {
      const raw = await fs.readFile(DATA_FILE, 'utf8');
      store = JSON.parse(raw) || store;
    } catch (e) { /* ignore missing file */ }

    store.invites = store.invites || {};
    store.invites[code] = { createdAt: Date.now() };

    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');

    const frontendUrl = (process.env.FRONTEND_URL && process.env.FRONTEND_URL.trim()) ? process.env.FRONTEND_URL.trim() : `${req.protocol}://${req.get('host')}`;
    const url = `${frontendUrl}/?room=${encodeURIComponent(code)}`;
    res.json({ ok: true, roomId: code, url });
  } catch (err) {
    console.error('/create-room error', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// Support (basic store)
app.post('/support', async (req, res) => {
  try {
    const body = req.body || {};
    const name = (body.name || '').trim();
    const email = (body.email || '').trim();
    const subject = (body.subject || '').trim();
    const message = (body.message || '').trim();
    if (!email || !message) return res.status(400).json({ ok: false, error: 'Missing email or message' });

    let store = { supportMessages: [] };
    try {
      const raw = await fs.readFile(DATA_FILE, 'utf8');
      store = JSON.parse(raw) || store;
    } catch (e) { /* ignore missing file */ }

    const id = uuidv4();
    store.supportMessages = store.supportMessages || [];
    store.supportMessages.push({ id, name, email, subject, message, createdAt: Date.now() });
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');

    res.json({ ok: true });
  } catch (err) {
    console.error('/support error', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// Optional REST endpoint for chunk data
app.get('/chunk/:cx/:cz', (req, res) => {
  const { cx, cz } = req.params;
  const key = `${cx},${cz}`;
  const chunk = chunks.get(key);
  if (chunk) {
    res.json({ ok: true, chunk });
  } else {
    // Generate default chunk (flat grass at y=0)
    const generated = generateChunk(parseInt(cx, 10), parseInt(cz, 10));
    chunks.set(key, generated);
    res.json({ ok: true, chunk: generated });
  }
});

// --- Chunk generation helper ---
function generateChunk(cx, cz) {
  const CHUNK_SIZE = 16;
  const blocks = [];
  // Simple flat world: grass at y=0
  for (let x = 0; x < CHUNK_SIZE; x++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      blocks.push({ x, y: 0, z, type: 1 }); // type 1 = grass
    }
  }
  return { cx, cz, blocks };
}

// --- Socket.IO setup ---
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Helper: get or create room state
function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      players: new Map(),
      shields: new Map(),
      captureTimers: new Map()
    });
  }
  return rooms.get(roomId);
}

// Helper: distance between two 3D points
function distance3D(a, b) {
  const dx = (a.x || 0) - (b.x || 0);
  const dy = (a.y || 0) - (b.y || 0);
  const dz = (a.z || 0) - (b.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  let currentRoomId = null;
  let playerName = 'Player';

  socket.on('joinGame', (payload) => {
    const name = (payload && payload.name) ? String(payload.name).trim() : '';
    // enforce: single-word letters-only must include '#'
    if (/^[A-Za-z]{2,30}$/.test(name) && !name.includes('#')) {
      socket.emit('joinError', { message: 'Single-word names require a # suffix (e.g., Todd#1234).' });
      return;
    }

    playerName = name || 'Player';
    currentRoomId = (payload && payload.roomId) || 'default';
    const room = getRoom(currentRoomId);

    // Initialize player
    room.players.set(socket.id, {
      id: socket.id,
      name: playerName,
      position: { x: 0, y: 1, z: 0 },
      role: 'hider',
      shield: null,
      lastUpdate: Date.now()
    });

    socket.join(currentRoomId);
    console.log('joinGame', socket.id, playerName, currentRoomId);
    socket.emit('joinedRoom', { roomId: currentRoomId, playerId: socket.id, name: playerName });

    // Optionally spawn a shield in the world
    spawnShieldInWorld(currentRoomId);
  });

  // Position updates
  socket.on('pos', (data) => {
    if (!currentRoomId) return;
    const room = getRoom(currentRoomId);
    const player = room.players.get(socket.id);
    if (player && data) {
      player.position = { x: data.x || 0, y: data.y || 0, z: data.z || 0 };
      player.lastUpdate = Date.now();

      // Check for captures (seeker touching hider)
      checkCaptures(currentRoomId, socket);
    }
  });

  // Chunk requests
  socket.on('chunkRequest', (data) => {
    const { cx, cz } = data || {};
    if (cx === undefined || cz === undefined) return;
    const key = `${cx},${cz}`;
    let chunk = chunks.get(key);
    if (!chunk) {
      chunk = generateChunk(cx, cz);
      chunks.set(key, chunk);
    }
    socket.emit('chunkData', chunk);
  });

  // Block placement
  socket.on('blockPlace', (data) => {
    const { cx, cz, x, y, z, type } = data || {};
    if (cx === undefined || cz === undefined || x === undefined || y === undefined || z === undefined || type === undefined) return;
    const key = `${cx},${cz}`;
    let chunk = chunks.get(key);
    if (!chunk) {
      chunk = generateChunk(cx, cz);
      chunks.set(key, chunk);
    }
    // Add block (simple: just append; in production you'd handle duplicates)
    chunk.blocks.push({ x, y, z, type });
    console.log('blockPlace', socket.id, cx, cz, x, y, z, type);

    // Broadcast to others in room
    if (currentRoomId) {
      socket.to(currentRoomId).emit('blockUpdate', { cx, cz, x, y, z, type, action: 'place' });
    }
  });

  // Block removal
  socket.on('blockRemove', (data) => {
    const { cx, cz, x, y, z } = data || {};
    if (cx === undefined || cz === undefined || x === undefined || y === undefined || z === undefined) return;
    const key = `${cx},${cz}`;
    const chunk = chunks.get(key);
    if (!chunk) return;
    // Remove block
    chunk.blocks = chunk.blocks.filter(b => !(b.x === x && b.y === y && b.z === z));
    console.log('blockRemove', socket.id, cx, cz, x, y, z);

    // Broadcast to others in room
    if (currentRoomId) {
      socket.to(currentRoomId).emit('blockUpdate', { cx, cz, x, y, z, type: 0, action: 'remove' });
    }
  });

  // Shooting (tranquilizer dart / shield hit)
  socket.on('shoot', (data) => {
    if (!currentRoomId) return;
    const room = getRoom(currentRoomId);
    const shooter = room.players.get(socket.id);
    if (!shooter) return;

    const { targetId } = data || {};
    const target = room.players.get(targetId);
    if (!target) return;

    // Check if target has a shield
    if (target.shield && target.shield.durability > 0) {
      target.shield.durability--;
      console.log('shieldHit', targetId, 'durability', target.shield.durability);
      io.to(targetId).emit('shieldHit', { durability: target.shield.durability });

      if (target.shield.durability <= 0) {
        console.log('shieldDestroyed', targetId);
        target.shield = null;
        io.to(targetId).emit('shieldDestroyed');
      }
    } else {
      // No shield, apply tranquilizer or other effect
      console.log('shoot', socket.id, '->', targetId);
      io.to(targetId).emit('hit', { shooterId: socket.id });
    }
  });

  // Pickup (shield or other item)
  socket.on('pickup', (data) => {
    if (!currentRoomId) return;
    const room = getRoom(currentRoomId);
    const player = room.players.get(socket.id);
    if (!player) return;

    const { itemId } = data || {};
    const shield = room.shields.get(itemId);
    if (!shield) return;

    // Give shield to player
    player.shield = { durability: SHIELD_DURABILITY };
    room.shields.delete(itemId);
    console.log('shieldPicked', socket.id, itemId);
    socket.emit('shieldPickedUp', { durability: SHIELD_DURABILITY });

    // Broadcast shield removal
    io.to(currentRoomId).emit('shieldRemoved', { itemId });
  });

  socket.on('disconnect', () => {
    console.log('socket disconnected', socket.id);
    if (currentRoomId) {
      const room = getRoom(currentRoomId);
      room.players.delete(socket.id);
      room.captureTimers.delete(socket.id);
    }
  });
});

// Helper: spawn a shield as a world item (pickup)
function spawnShieldInWorld(roomId) {
  const room = getRoom(roomId);
  const shieldId = uuidv4();
  const shield = {
    id: shieldId,
    position: { x: Math.random() * 20 - 10, y: 1, z: Math.random() * 20 - 10 },
    durability: SHIELD_DURABILITY
  };
  room.shields.set(shieldId, shield);
  console.log('Shield spawned in', roomId, shieldId);
  io.to(roomId).emit('shieldSpawned', shield);
}

// Helper: check for captures (seeker near hider for CAPTURE_HOLD_MS)
function checkCaptures(roomId, seekerSocket) {
  const room = getRoom(roomId);
  const seeker = room.players.get(seekerSocket.id);
  if (!seeker || seeker.role !== 'seeker') return;

  room.players.forEach((hider, hiderId) => {
    if (hiderId === seekerSocket.id) return;
    if (hider.role !== 'hider') return;

    const dist = distance3D(seeker.position, hider.position);
    if (dist <= CAPTURE_DISTANCE) {
      // Start or continue capture timer
      if (!room.captureTimers.has(hiderId)) {
        const timer = setTimeout(() => {
          // Capture complete
          console.log('playerCaptured', hiderId, 'by', seekerSocket.id);
          hider.role = 'seeker';
          seeker.role = 'hider';
          io.to(hiderId).emit('becameSeeker');
          io.to(seekerSocket.id).emit('captured');
          room.captureTimers.delete(hiderId);
        }, CAPTURE_HOLD_MS);
        room.captureTimers.set(hiderId, timer);
      }
    } else {
      // Cancel capture timer
      const timer = room.captureTimers.get(hiderId);
      if (timer) {
        clearTimeout(timer);
        room.captureTimers.delete(hiderId);
      }
    }
  });
}

// Periodic state update broadcast
setInterval(() => {
  rooms.forEach((room, roomId) => {
    const snapshot = {
      players: Array.from(room.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        position: p.position,
        role: p.role,
        hasShield: !!p.shield
      })),
      shields: Array.from(room.shields.values())
    };
    io.to(roomId).emit('stateUpdate', snapshot);
  });
}, 100); // 10 Hz update rate

// Serve static frontend
app.use(express.static(FRONTEND_DIR));
app.get('*', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// Start
(async function start() {
  server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
})();
