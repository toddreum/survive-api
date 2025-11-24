const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*'
  }
});

const PORT = process.env.PORT || 3000;

// Optional static (not needed if you serve frontend from cPanel)
app.use(express.static(path.join(__dirname, 'public')));

// ===== GAME CONSTANTS =====
const TICK_RATE = 30; // 30 updates per second
const DT = 1 / TICK_RATE;
const ARENA_SIZE = 1600; // square arena
const PLAYER_RADIUS = 20;
const BULLET_SPEED = 800;
const PLAYER_SPEED = 400;
const MAX_LIGHT = 100;
const SHOOT_COST = 6;
const HIT_DAMAGE = 35;
const LIGHT_REGEN = 8; // per second in light zones
const PASSIVE_REGEN = 4; // per second out of combat
const BOT_COUNT = 4;
const MAX_PLAYERS = 8;

// Light wells (healing zones)
const LIGHT_WELLS = [
  { x: 0, y: 0, radius: 180 },
  { x: 500, y: 500, radius: 150 },
  { x: -550, y: -480, radius: 150 }
];

// ===== GAME STATE =====
let players = {};  // id -> player
let bullets = [];  // bullet objects
let lastUpdate = Date.now();

// Utility functions
function randRange(min, max) {
  return Math.random() * (max - min) + min;
}
function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function createPlayer(id, name, isBot = false) {
  const angle = randRange(0, Math.PI * 2);
  return {
    id,
    name,
    x: randRange(-ARENA_SIZE / 3, ARENA_SIZE / 3),
    y: randRange(-ARENA_SIZE / 3, ARENA_SIZE / 3),
    vx: 0,
    vy: 0,
    aimAngle: angle,
    input: { up: false, down: false, left: false, right: false, shooting: false },
    light: MAX_LIGHT,
    alive: true,
    respawnTimer: 0,
    color: isBot ? randomNeonColor() : '#fb923c',
    isBot,
    botThinkTimer: 0
  };
}

function randomNeonColor() {
  const palette = ['#4ade80', '#38bdf8', '#f97316', '#e11d48', '#a855f7'];
  return palette[Math.floor(Math.random() * palette.length)];
}

function spawnBotsIfNeeded() {
  const currentBots = Object.values(players).filter(p => p.isBot).length;
  for (let i = currentBots; i < BOT_COUNT; i++) {
    const id = `bot-${i}-${Date.now()}`;
    players[id] = createPlayer(id, `Bot ${i + 1}`, true);
  }
}

// ===== SOCKET HANDLERS =====
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join', (name) => {
    if (Object.keys(players).length >= MAX_PLAYERS) {
      socket.emit('joinRejected', 'Arena is full, try again later.');
      return;
    }
    const playerName = (name || 'Runner').toString().slice(0, 18);
    players[socket.id] = createPlayer(socket.id, playerName, false);
    console.log(`${playerName} joined as ${socket.id}`);
    socket.emit('joined', { id: socket.id });

    spawnBotsIfNeeded();
  });

  socket.on('input', (data) => {
    const p = players[socket.id];
    if (!p || p.isBot) return;
    p.input = {
      up: !!data.up,
      down: !!data.down,
      left: !!data.left,
      right: !!data.right,
      shooting: !!data.shooting
    };
    if (typeof data.aimAngle === 'number') {
      p.aimAngle = data.aimAngle;
    }
  });

  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (p) {
      console.log(`${p.name} disconnected (${socket.id})`);
      delete players[socket.id];
    }
  });
});

// ===== GAME TICK =====
function update() {
  const now = Date.now();
  let dt = (now - lastUpdate) / 1000;
  if (dt > 0.1) dt = 0.1;
  lastUpdate = now;

  // Player movement & actions
  for (const id in players) {
    const p = players[id];

    if (!p.alive) {
      p.respawnTimer -= dt;
      if (p.respawnTimer <= 0) {
        Object.assign(p, createPlayer(id, p.name, p.isBot));
      }
      continue;
    }

    if (p.isBot) botLogic(p, dt);

    const { up, down, left, right, shooting } = p.input;
    let mx = 0, my = 0;
    if (up) my -= 1;
    if (down) my += 1;
    if (left) mx -= 1;
    if (right) mx += 1;
    const mag = Math.hypot(mx, my) || 1;
    const speed = PLAYER_SPEED;
    p.vx = (mx / mag) * speed;
    p.vy = (my / mag) * speed;

    p.x += p.vx * dt;
    p.y += p.vy * dt;

    const half = ARENA_SIZE / 2 - PLAYER_RADIUS;
    p.x = clamp(p.x, -half, half);
    p.y = clamp(p.y, -half, half);

    // Shooting
    if (shooting && p.light > SHOOT_COST + 5) {
      maybeShoot(p, dt);
    }

    // Light regen
    let regen = PASSIVE_REGEN;
    if (isInLightWell(p.x, p.y)) {
      regen += LIGHT_REGEN;
    }
    p.light += regen * dt;
    p.light = clamp(p.light, 0, MAX_LIGHT);
  }

  // Bullets
  for (const b of bullets) {
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.ttl -= dt;

    for (const id in players) {
      const p = players[id];
      if (!p.alive) continue;
      if (id === b.ownerId) continue;
      const dx = p.x - b.x;
      const dy = p.y - b.y;
      if (dx * dx + dy * dy <= (PLAYER_RADIUS * PLAYER_RADIUS)) {
        p.light -= HIT_DAMAGE;
        b.ttl = 0;
        if (p.light <= 0) {
          p.alive = false;
          p.respawnTimer = 3;
        }
        break;
      }
    }
  }
  bullets = bullets.filter(b => b.ttl > 0 && Math.abs(b.x) < ARENA_SIZE && Math.abs(b.y) < ARENA_SIZE);

  // Broadcast state
  const snapshot = {
    time: now,
    arenaSize: ARENA_SIZE,
    players: Object.values(players).map(p => ({
      id: p.id,
      name: p.name,
      x: p.x,
      y: p.y,
      aimAngle: p.aimAngle,
      light: p.light,
      maxLight: MAX_LIGHT,
      alive: p.alive,
      color: p.color,
      isBot: p.isBot
    })),
    bullets: bullets.map(b => ({
      x: b.x, y: b.y
    })),
    wells: LIGHT_WELLS
  };

  io.emit('state', snapshot);
}

let shootTimers = {}; // id -> cooldown accumulator

function maybeShoot(player, dt) {
  if (!shootTimers[player.id]) shootTimers[player.id] = 0;
  shootTimers[player.id] -= dt;
  if (shootTimers[player.id] > 0) return;

  shootTimers[player.id] = 0.18; // fire rate

  const angle = player.aimAngle;
  const sx = player.x + Math.cos(angle) * (PLAYER_RADIUS + 5);
  const sy = player.y + Math.sin(angle) * (PLAYER_RADIUS + 5);
  bullets.push({
    ownerId: player.id,
    x: sx,
    y: sy,
    vx: Math.cos(angle) * BULLET_SPEED,
    vy: Math.sin(angle) * BULLET_SPEED,
    ttl: 1.3
  });
  player.light -= SHOOT_COST;
  if (player.light < 0) player.light = 0;
}

function isInLightWell(x, y) {
  for (const w of LIGHT_WELLS) {
    const dx = x - w.x;
    const dy = y - w.y;
    if (dx * dx + dy * dy <= w.radius * w.radius) return true;
  }
  return false;
}

function botLogic(bot, dt) {
  bot.botThinkTimer -= dt;
  if (bot.botThinkTimer <= 0) {
    bot.botThinkTimer = randRange(0.3, 0.7);
    // find nearest visible opponent
    let target = null;
    let bestDist = Infinity;
    for (const p of Object.values(players)) {
      if (p.id === bot.id || !p.alive) continue;
      const dx = p.x - bot.x;
      const dy = p.y - bot.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDist) {
        bestDist = d2;
        target = p;
      }
    }
    if (target) {
      const dx = target.x - bot.x;
      const dy = target.y - bot.y;
      bot.aimAngle = Math.atan2(dy, dx);
      // Simple chase/strafe
      const angle = bot.aimAngle + randRange(-0.8, 0.8);
      bot.input = {
        up: false, down: false, left: false, right: false,
        shooting: true
      };
      // convert angle into directional inputs
      const dirx = Math.cos(angle), diry = Math.sin(angle);
      bot.input.up = diry < -0.3;
      bot.input.down = diry > 0.3;
      bot.input.left = dirx < -0.3;
      bot.input.right = dirx > 0.3;
    } else {
      // wander
      bot.input = {
        up: Math.random() < 0.5,
        down: Math.random() < 0.5,
        left: Math.random() < 0.5,
        right: Math.random() < 0.5,
        shooting: false
      };
    }
  }
}

// Initial bots
spawnBotsIfNeeded();

setInterval(update, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log('Lightfall Arena server running on port', PORT);
});
