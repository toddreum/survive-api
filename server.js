const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, message: 'Hide to Survive server is running.' });
});

// Optional static (not used with cPanel frontend)
app.use(express.static(path.join(__dirname, 'public')));

// ===== GAME CONSTANTS =====
const TICK_RATE = 30;
const ARENA_WIDTH = 1400;
const ARENA_HEIGHT = 900;
const PLAYER_RADIUS = 26;
const SEEKER_SPEED = 420;
const HIDER_SPEED = 360;
const TAG_DISTANCE = 48;

const HIDE_DURATION = 20;   // seconds
const HUNT_DURATION = 120;  // seconds
const POST_DURATION = 10;   // seconds

// Walls (rectangles; x,y = center)
const WALLS = [
  // Outer
  { x: 0, y: -420, width: 1300, height: 40 },
  { x: 0, y: 420,  width: 1300, height: 40 },
  { x: -650, y: 0, width: 40,  height: 800 },
  { x: 650,  y: 0, width: 40,  height: 800 },

  // Interior corridors
  { x: 0,   y: 0,   width: 40,  height: 700 },
  { x: 0,   y: 0,   width: 700, height: 40 },
  { x: -300, y: -200, width: 260, height: 40 },
  { x:  300, y:  200, width: 260, height: 40 },
  { x: -300, y:  200, width: 40,  height: 260 },
  { x:  300, y: -200, width: 40,  height: 260 },

  // Small cover pieces
  { x: 150,  y: -100, width: 180, height: 30 },
  { x: -150, y:  100, width: 180, height: 30 }
];

// ===== GAME STATE =====
const ROOM_ID = 'main';
let players = {}; // socketId -> player
let hostId = null;

let gameState = {
  phase: 'lobby',     // 'lobby' | 'hiding' | 'hunting' | 'post'
  phaseTimeLeft: 0,
  roundNumber: 0
};

function randRange(min, max) {
  return Math.random() * (max - min) + min;
}

function circleRectCollides(px, py, radius, rect) {
  const rx = rect.x;
  const ry = rect.y;
  const hw = rect.width / 2;
  const hh = rect.height / 2;

  const dx = Math.max(Math.abs(px - rx) - hw, 0);
  const dy = Math.max(Math.abs(py - ry) - hh, 0);
  return dx * dx + dy * dy <= radius * radius;
}

function placeInOpenArea() {
  // Try random positions until we find one not colliding with walls
  for (let i = 0; i < 50; i++) {
    const x = randRange(-ARENA_WIDTH / 2 + 80, ARENA_WIDTH / 2 - 80);
    const y = randRange(-ARENA_HEIGHT / 2 + 80, ARENA_HEIGHT / 2 - 80);
    let collides = false;
    for (const w of WALLS) {
      if (circleRectCollides(x, y, PLAYER_RADIUS + 4, w)) {
        collides = true;
        break;
      }
    }
    if (!collides) return { x, y };
  }
  return { x: 0, y: 0 };
}

function getPlayersArray() {
  return Object.values(players);
}

function broadcastLobby() {
  const lobbyData = {
    phase: gameState.phase,
    roundNumber: gameState.roundNumber,
    players: getPlayersArray().map(p => ({
      id: p.id,
      name: p.name,
      role: p.role,
      ready: p.ready,
      isHost: p.id === hostId
    }))
  };
  io.to(ROOM_ID).emit('lobbyUpdate', lobbyData);
}

function resetToLobby() {
  gameState.phase = 'lobby';
  gameState.phaseTimeLeft = 0;

  for (const p of getPlayersArray()) {
    p.role = 'hider';
    p.ready = false;
    p.alive = true;
    p.tagged = false;
    p.score += 1; // small reward for surviving a round
  }
  broadcastLobby();
}

function startRound() {
  const list = getPlayersArray().filter(p => p.connected);
  if (list.length < 2) return;

  gameState.roundNumber++;
  // Pick one seeker at random
  const seekerIndex = Math.floor(Math.random() * list.length);
  const seekerId = list[seekerIndex].id;

  for (const p of list) {
    const pos = placeInOpenArea();
    p.x = pos.x;
    p.y = pos.y;
    p.vx = 0;
    p.vy = 0;
    p.alive = true;
    p.tagged = false;
    if (p.id === seekerId) {
      p.role = 'seeker';
    } else {
      p.role = 'hider';
    }
  }

  gameState.phase = 'hiding';
  gameState.phaseTimeLeft = HIDE_DURATION;
  io.to(ROOM_ID).emit('roundStarted', {
    roundNumber: gameState.roundNumber,
    seekerId
  });
}

function advancePhase() {
  if (gameState.phase === 'hiding') {
    gameState.phase = 'hunting';
    gameState.phaseTimeLeft = HUNT_DURATION;
    io.to(ROOM_ID).emit('phaseChange', { phase: 'hunting' });
  } else if (gameState.phase === 'hunting') {
    // Determine winners
    const hidersAlive = getPlayersArray().filter(p => p.role === 'hider' && !p.tagged);
    const seeker = getPlayersArray().find(p => p.role === 'seeker');
    let result = 'draw';
    if (hidersAlive.length === 0) {
      result = 'seeker_win';
      if (seeker) seeker.score += 5;
    } else {
      result = 'hiders_win';
      for (const h of hidersAlive) h.score += 3;
    }
    gameState.phase = 'post';
    gameState.phaseTimeLeft = POST_DURATION;
    io.to(ROOM_ID).emit('roundEnded', { result });
  } else if (gameState.phase === 'post') {
    resetToLobby();
  }
}

// ===== SOCKET HANDLERS =====
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.join(ROOM_ID);

  // Setup player
  const name = 'Runner ' + socket.id.slice(0, 4);
  players[socket.id] = {
    id: socket.id,
    name,
    role: 'hider',
    ready: false,
    connected: true,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    alive: true,
    tagged: false,
    score: 0,
    input: { up: false, down: false, left: false, right: false }
  };

  if (!hostId) {
    hostId = socket.id;
  }

  broadcastLobby();

  socket.emit('connectedToRoom', {
    id: socket.id,
    hostId,
    phase: gameState.phase
  });

  socket.on('setName', (nameStr) => {
    const p = players[socket.id];
    if (!p) return;
    const newName = (nameStr || '').toString().trim().slice(0, 16);
    if (newName.length > 0) {
      p.name = newName;
      broadcastLobby();
    }
  });

  socket.on('setReady', (isReady) => {
    const p = players[socket.id];
    if (!p || gameState.phase !== 'lobby') return;
    p.ready = !!isReady;
    broadcastLobby();
  });

  socket.on('startRound', () => {
    if (socket.id !== hostId) return;
    if (gameState.phase !== 'lobby') return;

    const readyPlayers = getPlayersArray().filter(p => p.ready && p.connected);
    if (readyPlayers.length < 2) {
      socket.emit('errorMessage', 'Need at least 2 ready players to start.');
      return;
    }
    startRound();
  });

  socket.on('input', (data) => {
    const p = players[socket.id];
    if (!p) return;
    if (gameState.phase !== 'hiding' && gameState.phase !== 'hunting') return;
    p.input = {
      up: !!data.up,
      down: !!data.down,
      left: !!data.left,
      right: !!data.right
    };
  });

  socket.on('pingCheck', () => {
    socket.emit('pongCheck');
  });

  socket.on('disconnect', () => {
    console.log('Disconnect', socket.id);
    const wasHost = socket.id === hostId;
    if (players[socket.id]) {
      players[socket.id].connected = false;
      delete players[socket.id];
    }
    if (wasHost) {
      const remaining = getPlayersArray();
      hostId = remaining.length > 0 ? remaining[0].id : null;
    }
    if (Object.keys(players).length === 0) {
      gameState.phase = 'lobby';
      gameState.phaseTimeLeft = 0;
    }
    broadcastLobby();
  });
});

// ===== GAME LOOP =====
let lastUpdate = Date.now();

function gameLoop() {
  const now = Date.now();
  let dt = (now - lastUpdate) / 1000;
  lastUpdate = now;
  if (dt > 0.1) dt = 0.1;

  // Phase timing
  if (gameState.phase === 'hiding' || gameState.phase === 'hunting' || gameState.phase === 'post') {
    gameState.phaseTimeLeft -= dt;
    if (gameState.phaseTimeLeft <= 0) {
      advancePhase();
    }
  }

  // Movement & tagging during hiding/hunting
  if (gameState.phase === 'hiding' || gameState.phase === 'hunting') {
    for (const p of getPlayersArray()) {
      if (!p.alive || p.tagged) continue;

      const speed = p.role === 'seeker' ? SEEKER_SPEED : HIDER_SPEED;
      const inp = p.input || { up: false, down: false, left: false, right: false };

      let mx = 0, my = 0;
      if (inp.up) my -= 1;
      if (inp.down) my += 1;
      if (inp.left) mx -= 1;
      if (inp.right) mx += 1;
      const mag = Math.hypot(mx, my) || 1;

      p.vx = (mx / mag) * speed;
      p.vy = (my / mag) * speed;

      let newX = p.x + p.vx * dt;
      let newY = p.y + p.vy * dt;

      // Clamp to arena
      const halfW = ARENA_WIDTH / 2 - PLAYER_RADIUS;
      const halfH = ARENA_HEIGHT / 2 - PLAYER_RADIUS;
      newX = Math.max(-halfW, Math.min(halfW, newX));
      newY = Math.max(-halfH, Math.min(halfH, newY));

      // Check collisions with walls
      let collides = false;
      for (const w of WALLS) {
        if (circleRectCollides(newX, newY, PLAYER_RADIUS, w)) {
          collides = true;
          break;
        }
      }
      if (!collides) {
        p.x = newX;
        p.y = newY;
      }
    }

    // Tagging only during hunting
    if (gameState.phase === 'hunting') {
      const seekers = getPlayersArray().filter(p => p.role === 'seeker' && !p.tagged);
      const hiders = getPlayersArray().filter(p => p.role === 'hider' && !p.tagged);

      for (const s of seekers) {
        for (const h of hiders) {
          const dx = h.x - s.x;
          const dy = h.y - s.y;
          if (dx * dx + dy * dy <= TAG_DISTANCE * TAG_DISTANCE) {
            h.tagged = true;
            io.to(ROOM_ID).emit('playerTagged', { hiderId: h.id, by: s.id });
          }
        }
      }

      const remainingHiders = hiders.filter(h => !h.tagged);
      if (remainingHiders.length === 0) {
        gameState.phaseTimeLeft = 0; // trigger immediate advance to post
      }
    }
  }

  // Broadcast game state snapshot
  const snapshot = {
    t: now,
    phase: gameState.phase,
    phaseTimeLeft: Math.max(0, gameState.phaseTimeLeft),
    roundNumber: gameState.roundNumber,
    arena: {
      width: ARENA_WIDTH,
      height: ARENA_HEIGHT
    },
    walls: WALLS,
    players: getPlayersArray().map(p => ({
      id: p.id,
      name: p.name,
      role: p.role,
      x: p.x,
      y: p.y,
      tagged: p.tagged,
      score: p.score
    }))
  };

  io.to(ROOM_ID).emit('state', snapshot);
}

setInterval(gameLoop, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log('Hide to Survive server running on port', PORT);
});
