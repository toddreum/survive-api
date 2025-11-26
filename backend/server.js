'use strict';
/*
 Production-ready combined server with:
 - GET /health
 - POST /create-room
 - POST /support
 - Serves static frontend from ../frontend/public
 - Socket.IO for realtime gameplay with:
   - In-memory player state and items (shields)
   - Position updates (pos)
   - Pickup events
   - Ack-based join flow
   - Periodic game tick (150-200ms)
   - Capture mechanics (distance=3.0, holdMs=800)
   - Shield durability and blocking
   - Role swaps and scoring
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
const TICK_RATE = 150; // ms between game ticks
const CAPTURE_DISTANCE = 3.0;
const CAPTURE_HOLD_MS = 800;
const SHIELD_DURATION_MS = 15000; // 15 seconds
const SHIELD_DURABILITY = 3; // hits before destroyed
const PLAYER_STALE_MS = 30000; // 30 seconds without pos update

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
console.log('[server] Allowed origins for CORS/socket.io:', ALLOWED_ORIGINS);

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

// --- Game State ---
const gameState = {
  rooms: {}, // roomId -> { players: {}, items: {}, captureProgress: {} }
};

// Helper: get or create room
function getRoom(roomId) {
  if (!gameState.rooms[roomId]) {
    gameState.rooms[roomId] = {
      players: {},
      items: {},
      captureProgress: {}
    };
  }
  return gameState.rooms[roomId];
}

// Helper: calculate distance
function distance(p1, p2) {
  const dx = (p1.x || 0) - (p2.x || 0);
  const dy = (p1.y || 0) - (p2.y || 0);
  const dz = (p1.z || 0) - (p2.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
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

io.on('connection', (socket) => {
  console.log('[server] socket connected', socket.id);

  socket.on('joinGame', (payload, ack) => {
    const name = (payload && payload.name) ? String(payload.name).trim() : '';
    // enforce: single-word letters-only must include '#'
    if (/^[A-Za-z]{2,30}$/.test(name) && !name.includes('#')) {
      socket.emit('joinError', { message: 'Single-word names require a # suffix (e.g., Todd#1234).' });
      if (ack) ack({ error: 'name_requires_suffix' });
      return;
    }

    const roomId = (payload && payload.roomId) || 'default';
    const room = getRoom(roomId);
    
    console.log('[server] joinGame received', socket.id, name, roomId);

    // Add player to room
    const playerCount = Object.keys(room.players).length;
    const role = playerCount === 0 ? 'seeker' : 'hider';
    
    room.players[socket.id] = {
      id: socket.id,
      name: name || 'Player',
      roomId,
      role,
      x: 0,
      y: 0,
      z: 0,
      score: 0,
      shieldId: null,
      lastUpdate: Date.now()
    };

    socket.join(roomId);

    const joinedPayload = {
      roomId,
      playerId: socket.id,
      name: name || 'Player',
      role
    };

    socket.emit('joinedRoom', joinedPayload);
    console.log('[server] joinedRoom emitted', socket.id, roomId);

    if (ack) ack({ ok: true, ...joinedPayload });

    // Broadcast to room
    io.to(roomId).emit('playerJoined', {
      playerId: socket.id,
      name: name || 'Player',
      role
    });
  });

  socket.on('pos', (data) => {
    // Update player position
    for (const roomId in gameState.rooms) {
      const room = gameState.rooms[roomId];
      if (room.players[socket.id]) {
        room.players[socket.id].x = data.x || 0;
        room.players[socket.id].y = data.y || 0;
        room.players[socket.id].z = data.z || 0;
        room.players[socket.id].lastUpdate = Date.now();
        break;
      }
    }
  });

  socket.on('pickup', (data) => {
    const itemId = data && data.itemId;
    if (!itemId) return;

    console.log('[server] pickup attempt', socket.id, itemId);

    for (const roomId in gameState.rooms) {
      const room = gameState.rooms[roomId];
      const player = room.players[socket.id];
      if (!player) continue;

      const item = room.items[itemId];
      if (!item || item.pickedUp) continue;

      // Check distance
      const dist = distance(player, item);
      if (dist > 5.0) continue;

      // Pick up shield
      if (item.type === 'shield') {
        item.pickedUp = true;
        item.pickedBy = socket.id;
        item.pickedAt = Date.now();
        
        player.shieldId = itemId;
        player.shieldDurability = SHIELD_DURABILITY;
        player.shieldExpiry = Date.now() + SHIELD_DURATION_MS;

        console.log('[server] shieldPicked', socket.id, itemId);
        
        socket.emit('shieldPicked', {
          itemId,
          durability: player.shieldDurability,
          expiryMs: SHIELD_DURATION_MS
        });

        io.to(roomId).emit('itemPickedUp', {
          itemId,
          playerId: socket.id,
          type: 'shield'
        });
      }
      break;
    }
  });

  socket.on('shoot', (data) => {
    const targetId = data && data.targetId;
    if (!targetId) return;

    for (const roomId in gameState.rooms) {
      const room = gameState.rooms[roomId];
      const shooter = room.players[socket.id];
      const target = room.players[targetId];
      
      if (!shooter || !target) continue;
      if (shooter.role !== 'seeker') continue;

      // Check if target has shield
      if (target.shieldId && target.shieldDurability > 0) {
        target.shieldDurability--;
        
        console.log('[server] shieldHit', targetId, target.shieldDurability);
        
        io.to(targetId).emit('shieldHit', {
          durability: target.shieldDurability
        });

        if (target.shieldDurability <= 0) {
          target.shieldId = null;
          console.log('[server] shieldDestroyed', targetId);
          io.to(targetId).emit('shieldDestroyed');
        }

        io.to(roomId).emit('dartBlocked', {
          shooterId: socket.id,
          targetId,
          shieldDurability: target.shieldDurability
        });
      } else {
        // Apply tranquilizer effect
        io.to(targetId).emit('tranqApplied', {
          id: targetId,
          duration: 8000
        });
      }
      break;
    }
  });

  socket.on('disconnect', () => {
    console.log('[server] socket disconnected', socket.id);
    
    // Remove player from all rooms
    for (const roomId in gameState.rooms) {
      const room = gameState.rooms[roomId];
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        delete room.captureProgress[socket.id];
        
        io.to(roomId).emit('playerLeft', { playerId: socket.id });
      }
    }
  });
});

// --- Game Tick ---
setInterval(() => {
  const now = Date.now();

  for (const roomId in gameState.rooms) {
    const room = gameState.rooms[roomId];

    // Prune stale players
    for (const playerId in room.players) {
      const player = room.players[playerId];
      if (now - player.lastUpdate > PLAYER_STALE_MS) {
        console.log('[server] pruning stale player', playerId);
        delete room.players[playerId];
        delete room.captureProgress[playerId];
        io.to(roomId).emit('playerLeft', { playerId });
      }
    }

    // Process shield expiry
    for (const playerId in room.players) {
      const player = room.players[playerId];
      if (player.shieldId && player.shieldExpiry && now > player.shieldExpiry) {
        console.log('[server] shield expired', playerId);
        player.shieldId = null;
        player.shieldDurability = 0;
        io.to(playerId).emit('shieldDestroyed');
      }
    }

    // Check capture conditions
    const players = Object.values(room.players);
    const seeker = players.find(p => p.role === 'seeker');
    const hiders = players.filter(p => p.role === 'hider');

    if (seeker && hiders.length > 0) {
      for (const hider of hiders) {
        const dist = distance(seeker, hider);

        if (dist <= CAPTURE_DISTANCE) {
          // Seeker is near hider
          const captureKey = `${seeker.id}_${hider.id}`;
          
          if (!room.captureProgress[captureKey]) {
            room.captureProgress[captureKey] = {
              startTime: now,
              seeker: seeker.id,
              hider: hider.id
            };
          }

          const progress = room.captureProgress[captureKey];
          const elapsed = now - progress.startTime;

          if (elapsed >= CAPTURE_HOLD_MS) {
            // Capture complete - swap roles
            console.log('[server] playerCaptured', seeker.id, 'captured', hider.id);

            seeker.role = 'hider';
            hider.role = 'seeker';
            seeker.score += 1;

            io.to(roomId).emit('captured', {
              seekerId: seeker.id,
              hiderId: hider.id,
              newSeeker: hider.id
            });

            io.to(seeker.id).emit('becameHider');
            io.to(hider.id).emit('becameSeeker');

            delete room.captureProgress[captureKey];
          }
        } else {
          // Out of range - reset capture progress
          const captureKey = `${seeker.id}_${hider.id}`;
          if (room.captureProgress[captureKey]) {
            delete room.captureProgress[captureKey];
          }
        }
      }
    }

    // Emit state update
    const snapshot = {
      players: Object.values(room.players).map(p => ({
        id: p.id,
        name: p.name,
        role: p.role,
        x: p.x,
        y: p.y,
        z: p.z,
        score: p.score,
        hasShield: !!p.shieldId,
        shieldDurability: p.shieldDurability || 0
      })),
      items: Object.values(room.items).filter(i => !i.pickedUp).map(i => ({
        id: i.id,
        type: i.type,
        x: i.x,
        y: i.y,
        z: i.z
      }))
    };

    io.to(roomId).emit('stateUpdate', snapshot);
  }
}, TICK_RATE);

// Serve static frontend
app.use(express.static(FRONTEND_DIR));
app.get('*', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// Start
(async function start() {
  server.listen(PORT, () => console.log(`[server] listening on ${PORT}`));
})();
