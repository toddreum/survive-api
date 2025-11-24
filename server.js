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

// Optional static (not used if frontend is on cPanel)
app.use(express.static(path.join(__dirname, 'public')));

// ===== GAME CONSTANTS =====
const TICK_RATE = 30; // updates per second
const ARENA_SIZE = 1600; // square arena
const PLAYER_RADIUS = 24;
const BULLET_SPEED = 900;
const PLAYER_SPEED = 420;

const MAX_LIGHT = 100;
const SHOOT_COST = 7;
const HIT_DAMAGE = 40;
const LIGHT_REGEN = 10;   // per second in light wells
const PASSIVE_REGEN = 4;  // per second anywhere
const BOT_DESIRED_COUNT = 4;
const MAX_PLAYERS = 12;

// Light wells (healing / visibility zones)
const LIGHT_WELLS = [
  { x: 0, y: 0, radius: 200 },
  { x: 480, y: 480, radius: 160 },
  { x: -520, y: -460, radius: 160 },
  { x: -600, y: 520, radius: 140 }
];

// ===== GAME STATE =====
let players = {};  // id -> player
let bullets = [];  // bullet objects
let lastUpdate = Date.now();
let shootCooldowns = {}; // id -> cooldown seconds

// Utilities
function randRange(min, max) {
  return Math.random() * (max - min) + min;
}
function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}
function randomNeonColor() {
  const palette = ['#4ade80', '#38bdf8', '#f97316', '#e11d48', '#a855f7'];
  return palette[Math.floor(Math.random() * palette.length)];
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
    botThinkTimer: 0,
    score: 0   // kills
  };
}

function spawnBotsIfNeeded() {
  const currentBots = Object.values(players).filter(p => p.isBot).length;
  for (let i = currentBots; i < BOT_DESIRED_COUNT; i++) {
    const id = `bot-${i}-${Date.now()}`;
    players[id] = createPlayer(id, `BOT ${i + 1}`, true);
  }
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
    bot.botThinkTimer = randRange(0.25, 0.7);

    let target = null;
    let bestDist = Infinity;
    for (const p of Object.values(players)) {
      if (p.id === bot.id || !p.alive || p.isBot) continue; // prefer humans
      const dx = p.x - bot.x;
      const dy = p.y - bot.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDist) {
        bestDist = d2;
        target = p;
      }
    }
    // if no human found, chase any
    if (!target) {
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
    }

    if (target) {
      const dx = target.x - bot.x;
      const dy = target.y - bot.y;
      bot.aimAngle = Math.atan2(dy, dx);

      const angle = bot.aimAngle + randRange(-0.7, 0.7);
      const dirx = Math.cos(angle);
      const diry = Math.sin(angle);
      bot.input = {
        up: diry < -0.25,
        down: diry > 0.25,
        left: dirx < -0.25,
        right: dirx > 0.25,
        shooting: Math.random() < 0.8
      };
    } else {
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

function maybeShoot(player, dt) {
  const id = player.id;
  if (shootCooldowns[id] === undefined) shootCooldowns[id] = 0;
  shootCooldowns[id] -= dt;
  if (shootCooldowns[id] > 0) return;
  if (player.light <= SHOOT_COST + 5) return;

  shootCooldowns[id] = 0.18; // fire rate

  const angle = player.aimAngle;
  const sx = player.x + Math.cos(angle) * (PLAYER_RADIUS + 5);
  const sy = player.y + Math.sin(angle) * (PLAYER_RADIUS + 5);
  bullets.push({
    ownerId: player.id,
    x: sx,
    y: sy,
    vx: Math.cos(angle) * BULLET_SPEED,
    vy: Math.sin(angle) * BULLET_SPEED,
    ttl: 1.25
  });

  player.light -= SHOOT_COST;
  if (player.light < 0) player.light = 0;
}

// ===== SOCKET HANDLERS =====
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join', (name) => {
    if (Object.keys(players).length >= MAX_PLAYERS + BOT_DESIRED_COUNT) {
      socket.emit('joinRejected', 'Arena is full. Try again later.');
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
    if (!p || p.isBot || !p.alive) return;
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

  socket.on('pingCheck', () => {
    socket.emit('pongCheck');
  });

  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (p) {
      console.log(`${p.name} disconnected (${socket.id})`);
      delete players[socket.id];
      delete shootCooldowns[socket.id];
    }
  });
});

// ===== GAME LOOP =====
function update() {
  const now = Date.now();
  let dt = (now - lastUpdate) / 1000;
  if (dt > 0.1) dt = 0.1;
  lastUpdate = now;

  // Update players
  for (const id in players) {
    const p = players[id];

    if (!p.alive) {
      p.respawnTimer -= dt;
      if (p.respawnTimer <= 0) {
        const restored = createPlayer(id, p.name, p.isBot);
        restored.score = p.score; // keep kills
        players[id] = restored;
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
    p.vx = (mx / mag) * PLAYER_SPEED;
    p.vy = (my / mag) * PLAYER_SPEED;

    p.x += p.vx * dt;
    p.y += p.vy * dt;

    const half = ARENA_SIZE / 2 - PLAYER_RADIUS;
    p.x = clamp(p.x, -half, half);
    p.y = clamp(p.y, -half, half);

    if (shooting) {
      maybeShoot(p, dt);
    }

    let regen = PASSIVE_REGEN;
    if (isInLightWell(p.x, p.y)) regen += LIGHT_REGEN;
    p.light += regen * dt;
    p.light = clamp(p.light, 0, MAX_LIGHT);
  }

  // Update bullets
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
          if (players[b.ownerId]) {
            players[b.ownerId].score += 1;
          }
        }
        break;
      }
    }
  }
  bullets = bullets.filter(
    b => b.ttl > 0 &&
      Math.abs(b.x) < ARENA_SIZE &&
      Math.abs(b.y) < ARENA_SIZE
  );

  // Make sure bots exist
  spawnBotsIfNeeded();

  // Broadcast snapshot
  const snapshot = {
    t: now,
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
      isBot: p.isBot,
      score: p.score
    })),
    bullets: bullets.map(b => ({
      x: b.x,
      y: b.y
    })),
    wells: LIGHT_WELLS
  };

  io.emit('state', snapshot);
}

setInterval(update, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log('Survive Lightfall Arena server running on port', PORT);
});
