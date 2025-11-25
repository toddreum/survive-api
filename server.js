const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

// Socket.io with CORS (adjust origin in production if you want)
const io = new Server(server, {
  cors: {
    origin: "*", // e.g. ["https://hidetosurvive.com", "https://survive.com"]
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Simple health check
app.get('/', (req, res) => {
  res.send('Hide To Survive backend is running.');
});

// ===== GAME CONSTANTS =====
const TICK_RATE = 50; // 20 ticks/sec
const ROOM_MAX_PLAYERS = 16;

const MAP_WIDTH = 2200;
const MAP_HEIGHT = 2200;

const PLAYER_SPEED = 3.1;
const BOT_SPEED = 2.8;

const HIDE_TIME = 15000;    // 15 seconds to hide
const ROUND_TIME = 120000;  // 2 minutes

// ===== IN-MEMORY ROOMS =====
/*
room = {
  id,
  players: { socketId: playerObj },
  bots: [botObj],
  state: "waiting" | "hiding" | "seeking" | "finished",
  seekerId,
  roundStartTime,
  hideEndTime,
  finishTime,
  map: { width, height },
  createdAt
}
*/
const rooms = {};

function createRoom(roomId) {
  rooms[roomId] = {
    id: roomId,
    players: {},
    bots: [],
    state: 'waiting',
    seekerId: null,
    roundStartTime: null,
    hideEndTime: null,
    finishTime: null,
    map: { width: MAP_WIDTH, height: MAP_HEIGHT },
    createdAt: Date.now()
  };
}

// Utility functions
function randomPosition() {
  return {
    x: Math.random() * MAP_WIDTH,
    y: Math.random() * MAP_HEIGHT
  };
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// ===== GAME LOOP =====
setInterval(() => {
  const now = Date.now();

  Object.values(rooms).forEach(room => {
    const playerCount = Object.keys(room.players).length;
    const botCount = room.bots.length;

    // Clean up empty rooms after 30 minutes
    if (playerCount === 0 && botCount === 0) {
      if (now - room.createdAt > 30 * 60 * 1000) {
        delete rooms[room.id];
      }
      return;
    }

    handleRoomState(room, now);

    // Apply input to players
    Object.values(room.players).forEach(p => applyInput(p));

    // Update bots
    updateBots(room);

    // Tag detection
    handleTagging(room);

    // Broadcast snapshot
    const snapshot = buildSnapshot(room);
    io.to(room.id).emit('stateUpdate', snapshot);
  });
}, TICK_RATE);

// ===== STATE MACHINE =====
function handleRoomState(room, now) {
  const playerCount = Object.keys(room.players).length;
  const actorCount = playerCount + room.bots.length;

  if (actorCount < 2) {
    // Not enough to play
    room.state = 'waiting';
    room.seekerId = null;
    room.roundStartTime = null;
    room.hideEndTime = null;
    room.finishTime = null;
    return;
  }

  switch (room.state) {
    case 'waiting':
      startNewRound(room, now);
      break;
    case 'hiding':
      if (now >= room.hideEndTime) {
        room.state = 'seeking';
        room.roundStartTime = now;
      }
      break;
    case 'seeking': {
      const timeUp = now >= room.roundStartTime + ROUND_TIME;
      const anyHider = hasAnyHider(room);
      if (timeUp || !anyHider) {
        room.state = 'finished';
        room.finishTime = now;
      }
      break;
    }
    case 'finished':
      if (!room.finishTime) room.finishTime = now;
      if (now - room.finishTime > 8000) {
        startNewRound(room, now);
      }
      break;
  }
}

function startNewRound(room, now) {
  room.state = 'hiding';
  room.roundStartTime = null;
  room.hideEndTime = now + HIDE_TIME;
  room.finishTime = null;

  // Reset players
  Object.values(room.players).forEach(p => {
    const pos = randomPosition();
    p.x = pos.x;
    p.y = pos.y;
    p.vx = 0;
    p.vy = 0;
    p.caught = false;
    p.role = 'hider';
  });

  // Ensure some bots
  while (room.bots.length < 4) {
    const id = 'bot-' + uuidv4();
    const pos = randomPosition();
    room.bots.push({
      id,
      name: 'Bot ' + id.slice(0, 4),
      x: pos.x,
      y: pos.y,
      vx: 0,
      vy: 0,
      caught: false,
      role: 'hider',
      wanderAngle: Math.random() * Math.PI * 2
    });
  }
  room.bots.forEach(b => {
    const pos = randomPosition();
    b.x = pos.x;
    b.y = pos.y;
    b.vx = 0;
    b.vy = 0;
    b.caught = false;
    b.role = 'hider';
    b.wanderAngle = Math.random() * Math.PI * 2;
  });

  // Pick a seeker from combined pool (players + bots)
  const candidates = [
    ...Object.values(room.players).map(p => ({ type: 'player', id: p.id })),
    ...room.bots.map(b => ({ type: 'bot', id: b.id }))
  ];

  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  room.seekerId = chosen.id;

  Object.values(room.players).forEach(p => {
    p.role = (p.id === room.seekerId) ? 'seeker' : 'hider';
    p.caught = false;
  });
  room.bots.forEach(b => {
    b.role = (b.id === room.seekerId) ? 'seeker' : 'hider';
    b.caught = false;
  });

  io.to(room.id).emit('roundStarted', {
    seekerId: room.seekerId,
    hideTime: HIDE_TIME
  });
}

function hasAnyHider(room) {
  const playerHiders = Object.values(room.players).some(p => p.role === 'hider' && !p.caught);
  const botHiders = room.bots.some(b => b.role === 'hider' && !b.caught);
  return playerHiders || botHiders;
}

// ===== INPUT & MOVEMENT =====
function applyInput(p) {
  if (p.caught) return;
  const speed = PLAYER_SPEED;

  let vx = 0;
  let vy = 0;
  if (p.input.up) vy -= 1;
  if (p.input.down) vy += 1;
  if (p.input.left) vx -= 1;
  if (p.input.right) vx += 1;

  const len = Math.sqrt(vx * vx + vy * vy) || 1;
  vx = vx / len * speed;
  vy = vy / len * speed;

  p.x = Math.max(0, Math.min(MAP_WIDTH, p.x + vx));
  p.y = Math.max(0, Math.min(MAP_HEIGHT, p.y + vy));
}

// ===== BOT AI =====
function updateBots(room) {
  const seeker = getSeeker(room);
  const players = Object.values(room.players);

  room.bots.forEach(bot => {
    if (bot.caught) return;

    if (bot.role === 'hider') {
      // Hiders: run away if seeker is close, otherwise wander
      let dx = 0, dy = 0;
      if (seeker) {
        const d = dist(bot, seeker);
        if (d < 400) {
          dx = bot.x - seeker.x;
          dy = bot.y - seeker.y;
        } else {
          // wander
          if (Math.random() < 0.02) {
            bot.wanderAngle += (Math.random() - 0.5);
          }
          dx = Math.cos(bot.wanderAngle);
          dy = Math.sin(bot.wanderAngle);
        }
      }
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      bot.x = Math.max(0, Math.min(MAP_WIDTH, bot.x + (dx / len) * BOT_SPEED));
      bot.y = Math.max(0, Math.min(MAP_HEIGHT, bot.y + (dy / len) * BOT_SPEED));
    } else if (bot.role === 'seeker') {
      // Seeker bot chases nearest hider
      const targets = [
        ...players.filter(p => p.role === 'hider' && !p.caught),
        ...room.bots.filter(b => b.role === 'hider' && !b.caught)
      ];
      if (!targets.length) return;

      let closest = null;
      let minDist = Infinity;
      targets.forEach(t => {
        const d = dist(bot, t);
        if (d < minDist) {
          minDist = d;
          closest = t;
        }
      });

      if (closest) {
        const dx = closest.x - bot.x;
        const dy = closest.y - bot.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        bot.x = Math.max(0, Math.min(MAP_WIDTH, bot.x + (dx / len) * BOT_SPEED));
        bot.y = Math.max(0, Math.min(MAP_HEIGHT, bot.y + (dy / len) * BOT_SPEED));
      }
    }
  });
}

function getSeeker(room) {
  const fromPlayers = Object.values(room.players).find(p => p.id === room.seekerId);
  if (fromPlayers) return fromPlayers;
  return room.bots.find(b => b.id === room.seekerId) || null;
}

// ===== TAGGING =====
function handleTagging(room) {
  const seeker = getSeeker(room);
  if (!seeker) return;

  const TAG_RADIUS = 40;

  Object.values(room.players).forEach(p => {
    if (p.role === 'hider' && !p.caught && dist(seeker, p) < TAG_RADIUS) {
      p.caught = true;
      io.to(room.id).emit('playerTagged', { id: p.id });
    }
  });

  room.bots.forEach(b => {
    if (b.role === 'hider' && !b.caught && dist(seeker, b) < TAG_RADIUS) {
      b.caught = true;
      io.to(room.id).emit('botTagged', { id: b.id });
    }
  });
}

// ===== SNAPSHOT =====
function buildSnapshot(room) {
  return {
    state: room.state,
    seekerId: room.seekerId,
    players: Object.values(room.players).map(p => ({
      id: p.id,
      name: p.name,
      x: p.x,
      y: p.y,
      role: p.role,
      caught: p.caught
    })),
    bots: room.bots.map(b => ({
      id: b.id,
      name: b.name,
      x: b.x,
      y: b.y,
      role: b.role,
      caught: b.caught
    })),
    map: room.map,
    hideTimeRemaining: room.state === 'hiding'
      ? Math.max(0, room.hideEndTime - Date.now())
      : 0,
    roundTimeRemaining: room.state === 'seeking' && room.roundStartTime
      ? Math.max(0, room.roundStartTime + ROUND_TIME - Date.now())
      : 0
  };
}

// ===== SOCKET HANDLERS =====
io.on('connection', (socket) => {
  console.log('Client connected', socket.id);

  socket.on('joinGame', ({ name, roomId }) => {
    const finalRoomId = roomId && roomId.trim() ? roomId.trim() : 'default';

    if (!rooms[finalRoomId]) {
      createRoom(finalRoomId);
    }
    const room = rooms[finalRoomId];

    if (Object.keys(room.players).length >= ROOM_MAX_PLAYERS) {
      socket.emit('joinError', { message: 'Room is full.' });
      return;
    }

    const pos = randomPosition();
    room.players[socket.id] = {
      id: socket.id,
      name: name && name.trim() ? name.trim() : 'Player',
      x: pos.x,
      y: pos.y,
      vx: 0,
      vy: 0,
      role: 'hider',
      caught: false,
      input: { up: false, down: false, left: false, right: false }
    };

    socket.join(finalRoomId);
    socket.roomId = finalRoomId;

    socket.emit('joinedRoom', { roomId: finalRoomId, playerId: socket.id });
    console.log(`Player ${socket.id} joined room ${finalRoomId}`);
  });

  socket.on('input', (input) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;

    const player = rooms[roomId].players[socket.id];
    if (!player || player.caught) return;

    player.input = {
      up: !!input.up,
      down: !!input.down,
      left: !!input.left,
      right: !!input.right
    };
  });

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      delete rooms[roomId].players[socket.id];
      console.log(`Player ${socket.id} left room ${roomId}`);
    } else {
      console.log('Client disconnected', socket.id);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Hide To Survive backend listening on port ${PORT}`);
});
