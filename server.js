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
  res.json({ ok: true, message: 'Hide to Survive: Home Base Tag server is running.' });
});

// Optional static (not needed if frontend is on cPanel)
app.use(express.static(path.join(__dirname, 'public')));

// ===== GAME CONSTANTS =====
const TICK_RATE = 30;
const ARENA_WIDTH = 1400;
const ARENA_HEIGHT = 900;
const PLAYER_RADIUS = 26;

const CHASER_SPEED = 420;
const RUNNER_SPEED = 380;
const TAG_DISTANCE = 52;

const ROUND_DURATION = 90; // seconds
const POST_DURATION = 10;  // seconds between rounds

const BOT_DESIRED_COUNT = 4;

// Home base (runners must reach here)
const HOME_BASE = {
  x: ARENA_WIDTH / 2 - 180,
  y: ARENA_HEIGHT / 2 - 180,
  radius: 180
};

// Walls (rectangles; x,y = center)
const WALLS = [
  // Outer
  { x: 0, y: -420, width: 1300, height: 40 },
  { x: 0, y: 420,  width: 1300, height: 40 },
  { x: -650, y: 0, width: 40,  height: 800 },
  { x: 650,  y: 0, width: 40,  height: 800 },

  // Interior cross
  { x: 0, y: 0, width: 40, height: 700 },
  { x: 0, y: 0, width: 700, height: 40 },

  // Side corridors / rooms
  { x: -300, y: -200, width: 260, height: 40 },
  { x:  300, y:  200, width: 260, height: 40 },
  { x: -300, y:  200, width: 40,  height: 260 },
  { x:  300, y: -200, width: 40,  height: 260 },

  // Cover blocks
  { x: 150,  y: -100, width: 180, height: 30 },
  { x: -150, y:  100, width: 180, height: 30 }
];

// ===== GAME STATE =====
const ROOM_ID = 'main';

let players = {}; // id -> player
let hostId = null;

let gameState = {
  phase: 'lobby', // 'lobby' | 'playing' | 'post'
  timeLeft: 0,
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
  for (let i = 0; i < 60; i++) {
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

function spawnBotsIfNeeded() {
  const bots = getPlayersArray().filter(p => p.isBot);
  const deficit = BOT_DESIRED_COUNT - bots.length;
  for (let i = 0; i < deficit; i++) {
    const id = `BOT-${Date.now()}-${Math.floor(Math.random() * 9999)}`;
    players[id] = createPlayer(id, `Bot ${bots.length + i + 1}`, true);
  }
}

function createPlayer(id, name, isBot = false) {
  return {
    id,
    name,
    isBot,
    role: 'runner', // 'runner' or 'chaser'
    ready: false,
    connected: !isBot,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    input: { up: false, down: false, left: false, right: false },
    safe: false,
    tagged: false,
    score: 0
  };
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
      isHost: p.id === hostId,
      isBot: p.isBot,
      score: p.score
    }))
  };
  io.to(ROOM_ID).emit('lobbyUpdate', lobbyData);
}

function resetToLobby() {
  gameState.phase = 'lobby';
  gameState.timeLeft = 0;

  for (const p of getPlayersArray()) {
    p.role = 'runner';
    p.ready = false;
    p.safe = false;
    p.tagged = false;
    p.vx = 0;
    p.vy = 0;
  }
  broadcastLobby();
}

function startRound() {
  const activeHumans = getPlayersArray().filter(p => p.connected);
  if (activeHumans.length === 0) return;

  spawnBotsIfNeeded();
  const all = getPlayersArray();

  gameState.roundNumber++;
  gameState.phase = 'playing';
  gameState.timeLeft = ROUND_DURATION;

  // Pick one chaser among HUMANS if possible, otherwise any
  let candidates = activeHumans;
  if (candidates.length < 1) candidates = all;

  const chaserIndex = Math.floor(Math.random() * candidates.length);
  const chaserId = candidates[chaserIndex].id;

  for (const p of all) {
    const pos = placeInOpenArea();
    p.x = pos.x;
    p.y = pos.y;
    p.vx = 0;
    p.vy = 0;
    p.safe = false;
    p.tagged = false;
    p.role = (p.id === chaserId) ? 'chaser' : 'runner';
  }

  io.to(ROOM_ID).emit('roundStarted', {
    roundNumber: gameState.roundNumber,
    chaserId
  });
  broadcastLobby();
}

function endRound(reason) {
  // Simple scoring:
  // - Runners: +3 if safe, +1 if still untagged when time ends
  // - Chaser: +2 per tag
  const chaser = getPlayersArray().find(p => p.role === 'chaser');
  const runners = getPlayersArray().filter(p => p.role === 'runner');

  let tagsCount = 0;
  for (const r of runners) {
    if (r.safe) r.score += 3;
    else if (!r.tagged) r.score += 1;
    if (r.tagged) tagsCount++;
  }
  if (chaser) {
    chaser.score += tagsCount * 2;
  }

  gameState.phase = 'post';
  gameState.timeLeft = POST_DURATION;

  io.to(ROOM_ID).emit('roundEnded', {
    reason,
    tagsCount
  });
  broadcastLobby();
}

function checkRoundEnd() {
  const runners = getPlayersArray().filter(p => p.role === 'runner');
  if (runners.length === 0) return; // weird but okay

  const allDone = runners.every(r => r.safe || r.tagged);
  if (allDone) {
    endRound('all_resolved');
  }
}

// Bots AI
function botLogic(p, dt) {
  if (!p.isBot) return;
  if (gameState.phase !== 'playing') return;

  const others = getPlayersArray().filter(o => o.id !== p.id);

  if (p.role === 'chaser') {
    // Move toward nearest runner
    let target = null;
    let bestD2 = Infinity;
    for (const r of others) {
      if (r.role !== 'runner' || r.tagged || r.safe) continue;
      const dx = r.x - p.x;
      const dy = r.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        target = r;
      }
    }
    if (target) {
      const dx = target.x - p.x;
      const dy = target.y - p.y;
      const mag = Math.hypot(dx, dy) || 1;
      const dirx = dx / mag;
      const diry = dy / mag;
      p.input = {
        up: diry < -0.2,
        down: diry > 0.2,
        left: dirx < -0.2,
        right: dirx > 0.2
      };
    }
  } else {
    // Runner AI: move toward base but also away from chaser
    const baseDx = HOME_BASE.x - (ARENA_WIDTH / 2) - p.x;
    const baseDy = HOME_BASE.y - (ARENA_HEIGHT / 2) - p.y;

    let chaser = others.find(o => o.role === 'chaser');
    let avoidX = 0;
    let avoidY = 0;
    if (chaser) {
      const dx = p.x - chaser.x;
      const dy = p.y - chaser.y;
      const d2 = dx * dx + dy * dy;
      const dist = Math.sqrt(d2) || 1;
      const factor = dist < 280 ? 1.5 : 0.4;
      avoidX = (dx / dist) * factor;
      avoidY = (dy / dist) * factor;
    }

    const targetX = baseDx + avoidX * 120;
    const targetY = baseDy + avoidY * 120;
    const mag = Math.hypot(targetX, targetY) || 1;
    const dirx = targetX / mag;
    const diry = targetY / mag;

    p.input = {
      up: diry < -0.1,
      down: diry > 0.1,
      left: dirx < -0.1,
      right: dirx > 0.1
    };
  }
}

// ===== SOCKET HANDLERS =====
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.join(ROOM_ID);

  const name = 'Player ' + socket.id.slice(0, 4);
  players[socket.id] = createPlayer(socket.id, name, false);
  players[socket.id].connected = true;

  if (!hostId) {
    hostId = socket.id;
  }

  spawnBotsIfNeeded();
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

    const readyHumans = getPlayersArray().filter(p => p.connected && p.ready);
    if (readyHumans.length < 1) {
      socket.emit('errorMessage', 'You need at least 1 ready human player to start.');
      return;
    }
    startRound();
  });

  socket.on('input', (data) => {
    const p = players[socket.id];
    if (!p) return;
    if (gameState.phase !== 'playing') return;
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
      delete players[socket.id];
    }
    if (wasHost) {
      const remainingHumans = getPlayersArray().filter(p => !p.isBot);
      hostId = remainingHumans.length ? remainingHumans[0].id : null;
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

  spawnBotsIfNeeded();

  if (gameState.phase === 'playing' || gameState.phase === 'post') {
    gameState.timeLeft -= dt;
    if (gameState.timeLeft <= 0) {
      if (gameState.phase === 'playing') {
        endRound('time_up');
      } else if (gameState.phase === 'post') {
        resetToLobby();
      }
    }
  }

  if (gameState.phase === 'playing') {
    for (const p of getPlayersArray()) {
      if (p.tagged || p.safe) continue;

      // Bot AI
      if (p.isBot) {
        botLogic(p, dt);
      }

      const inp = p.input || { up: false, down: false, left: false, right: false };
      const speed = p.role === 'chaser' ? CHASER_SPEED : RUNNER_SPEED;

      let mx = 0;
      let my = 0;
      if (inp.up) my -= 1;
      if (inp.down) my += 1;
      if (inp.left) mx -= 1;
      if (inp.right) mx += 1;
      const mag = Math.hypot(mx, my) || 1;

      p.vx = (mx / mag) * speed;
      p.vy = (my / mag) * speed;

      // Position in arena coordinates (origin center)
      let newX = p.x + p.vx * dt;
      let newY = p.y + p.vy * dt;

      const halfW = ARENA_WIDTH / 2 - PLAYER_RADIUS;
      const halfH = ARENA_HEIGHT / 2 - PLAYER_RADIUS;
      newX = Math.max(-halfW, Math.min(halfW, newX));
      newY = Math.max(-halfH, Math.min(halfH, newY));

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

      // Check home base for runners
      if (p.role === 'runner' && !p.safe && !p.tagged) {
        // Convert HOME_BASE from top-left-ish to game coords (we'll handle in client similarly)
        const baseWorldX = HOME_BASE.x - ARENA_WIDTH / 2;
        const baseWorldY = HOME_BASE.y - ARENA_HEIGHT / 2;
        const dx = p.x - baseWorldX;
        const dy = p.y - baseWorldY;
        if (dx * dx + dy * dy <= HOME_BASE.radius * HOME_BASE.radius) {
          p.safe = true;
        }
      }
    }

    // Tagging
    const chasers = getPlayersArray().filter(p => p.role === 'chaser' && !p.tagged);
    const runners = getPlayersArray().filter(p => p.role === 'runner' && !p.safe && !p.tagged);

    for (const c of chasers) {
      for (const r of runners) {
        const dx = r.x - c.x;
        const dy = r.y - c.y;
        if (dx * dx + dy * dy <= TAG_DISTANCE * TAG_DISTANCE) {
          r.tagged = true;
          io.to(ROOM_ID).emit('playerTagged', { runnerId: r.id, by: c.id });
        }
      }
    }

    checkRoundEnd();
  }

  // Broadcast state snapshot
  const snapshot = {
    t: now,
    phase: gameState.phase,
    timeLeft: Math.max(0, gameState.timeLeft),
    roundNumber: gameState.roundNumber,
    arena: {
      width: ARENA_WIDTH,
      height: ARENA_HEIGHT
    },
    homeBase: HOME_BASE,
    walls: WALLS,
    players: getPlayersArray().map(p => ({
      id: p.id,
      name: p.name,
      role: p.role,
      x: p.x,
      y: p.y,
      safe: p.safe,
      tagged: p.tagged,
      isBot: p.isBot,
      score: p.score
    }))
  };

  io.to(ROOM_ID).emit('state', snapshot);
}

setInterval(gameLoop, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log('Hide to Survive: Home Base Tag server running on port', PORT);
});
