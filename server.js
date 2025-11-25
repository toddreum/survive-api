'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');

const app = express();
// JSON body parsing for admin endpoints
app.use(express.json());
app.disable('x-powered-by');

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// ============ CONFIG (env-driven) ============
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // Set a strong token in Render env
const RESERVED_NAMES_CSV = process.env.RESERVED_NAMES || 'admin,moderator,staff,survive,survive.com';
const RESERVED_NAMES = RESERVED_NAMES_CSV.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// Persistence file for purchased/unlocked names (simple file-based store)
const DATA_FILE = process.env.DATA_FILE || path.resolve(__dirname, 'persist.json');

// ============ GAME CONSTANTS ============
const TICK_RATE = 50; // ms
const ROOM_MAX_PLAYERS = 16;

const MAP_WIDTH = 2200;
const MAP_HEIGHT = 2200;

const PLAYER_SPEED = 3.1;
const BOT_SPEED = 2.8;

const HIDE_TIME = 15000;
const ROUND_TIME = 120000;

const SCORE_TAG = 50;
const SCORE_SURVIVE = 100;
const SCORE_CAUGHT_PENALTY = 20;
const SCORE_FULL_WIPE_BONUS = 75;

const SHOOT_RADIUS = 80;

// Tranquilizer & Wake Serum
const TRANQ_DURATION = 8000;
const TRANQ_SLOW_MULT = 0.35;
const SERUM_PICKUP_RADIUS = 45;
const SERUM_PER_ROUND = 4;

// rooms map (in-memory)
const rooms = {};

// purchasedNames store (in-memory, persisted to DATA_FILE)
// structure: { purchased: { "<basename>": { owner: "<owner-id-or-meta>", grantedAt: 123456789 } } }
let store = { purchased: {} };

// ============ PERSISTENCE HELPERS ============
async function loadStore() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    store = JSON.parse(raw) || { purchased: {} };
    console.log(`Loaded store from ${DATA_FILE}`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      store = { purchased: {} };
      console.log('No persist file found, starting fresh store.');
    } else {
      console.error('Error loading store:', err);
      store = { purchased: {} };
    }
  }
}

async function saveStore() {
  try {
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
    // console.log(`Saved store to ${DATA_FILE}`);
  } catch (err) {
    console.error('Error saving store:', err);
  }
}

// ============ HELPERS ============
function nowMs() { return Date.now(); }

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function randomPosition() {
  return {
    x: Math.random() * MAP_WIDTH,
    y: Math.random() * MAP_HEIGHT
  };
}

function isValidNumber(n) {
  return typeof n === 'number' && Number.isFinite(n) && !Number.isNaN(n);
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function sanitizeRequestedName(raw) {
  if (!raw || typeof raw !== 'string') return 'Player';
  // trim and remove newlines
  let s = raw.trim().replace(/[\r\n]+/g, '');
  // disallow long names
  if (s.length > 30) s = s.slice(0, 30);
  return s || 'Player';
}

function generateSuffix() {
  // 4-digit numeric suffix
  return ('000' + Math.floor(Math.random() * 10000)).slice(-4);
}

function ensureHashSuffix(name) {
  // If name already contains '#', keep it (but normalize). If not, append #NNNN.
  if (name.includes('#')) {
    const parts = name.split('#');
    const base = parts[0].trim() || 'Player';
    const suffix = parts.slice(1).join('#').trim() || generateSuffix();
    return `${base}#${suffix}`;
  } else {
    return `${name}#${generateSuffix()}`;
  }
}

function nameBase(name) {
  return (typeof name === 'string' ? name.split('#')[0].trim().toLowerCase() : '').slice(0, 30);
}

function isReservedBase(base) {
  return RESERVED_NAMES.includes(base.toLowerCase());
}

function isPurchased(base) {
  if (!base) return false;
  return !!store.purchased[base.toLowerCase()];
}

function isReservedNameEffective(name) {
  const base = nameBase(name);
  if (!base) return false;
  if (isPurchased(base)) return false; // purchased -> allowed
  return isReservedBase(base);
}

function makeUniqueNameInRoom(room, desiredName) {
  // Ensure no other player in room has the same final display name
  let final = desiredName;
  const taken = new Set(Object.values(room.players).map(p => (p.name || '').toLowerCase()));
  let tries = 0;
  while (taken.has(final.toLowerCase()) && tries < 8) {
    const suffix = generateSuffix();
    const base = final.split('#')[0] || 'Player';
    final = `${base}#${suffix}`;
    tries++;
  }
  if (taken.has(final.toLowerCase())) {
    final = `${final.split('#')[0]}#${uuidv4().slice(0,4)}`;
  }
  return final;
}

// ============ ROOM MANAGEMENT ============
function createRoom(roomId, config = {}) {
  rooms[roomId] = {
    id: roomId,
    players: {},
    bots: [],
    state: "waiting",
    seekerId: null,
    roundStartTime: null,
    hideEndTime: null,
    finishTime: null,
    map: { width: MAP_WIDTH, height: MAP_HEIGHT },
    createdAt: Date.now(),
    config: {
      botCount: typeof config.botCount === "number" ? clamp(config.botCount, 0, 16) : 4,
      maxPlayers: ROOM_MAX_PLAYERS
    },
    scores: {},
    roundIndex: 0,
    powerups: []
  };
  console.log(`Created room ${roomId} (bots=${rooms[roomId].config.botCount})`);
}

function getOrCreatePlayerStats(room, id, name) {
  if (!room.scores[id]) {
    room.scores[id] = {
      id,
      name: name || "Player",
      score: 0,
      tags: 0,
      survived: 0,
      games: 0
    };
  } else if (name && room.scores[id].name !== name) {
    room.scores[id].name = name;
  }
  return room.scores[id];
}

// ============ GAME LOOP ============
setInterval(() => {
  const now = Date.now();

  Object.values(rooms).forEach((room) => {
    const playerCount = Object.keys(room.players).length;
    const botCount = room.bots.length;

    // Cleanup empty rooms older than 30 minutes
    if (playerCount === 0 && botCount === 0) {
      if (now - room.createdAt > 30 * 60 * 1000) {
        console.log(`Deleting idle room ${room.id}`);
        delete rooms[room.id];
      }
      return;
    }

    try {
      handleRoomState(room, now);
      updateStatusAndSerums(room, now);

      // apply inputs
      Object.values(room.players).forEach((p) => applyInput(p, now));
      updateBots(room, now);

      handleTagging(room);

      const snapshot = buildSnapshot(room);
      io.to(room.id).emit("stateUpdate", snapshot);
    } catch (err) {
      console.error(`Error in game loop for room ${room.id}:`, err);
    }
  });
}, TICK_RATE);

// ============ STATE MACHINE ============
function handleRoomState(room, now) {
  const playerCount = Object.keys(room.players).length;

  if (playerCount === 0) {
    room.state = "waiting";
    room.seekerId = null;
    room.roundStartTime = null;
    room.hideEndTime = null;
    room.finishTime = null;
    return;
  }

  switch (room.state) {
    case "waiting":
      startNewRound(room, now);
      break;
    case "hiding":
      if (now >= room.hideEndTime) {
        room.state = "seeking";
        room.roundStartTime = now;
      }
      break;
    case "seeking": {
      const timeUp = now >= room.roundStartTime + ROUND_TIME;
      const anyHider = hasAnyHider(room);
      if (timeUp || !anyHider) {
        if (room.state !== "finished") {
          finishRound(room, now, !anyHider ? "all_caught" : "time_up");
        }
      }
      break;
    }
    case "finished":
      if (!room.finishTime) room.finishTime = now;
      if (now - room.finishTime > 8000) {
        startNewRound(room, now);
      }
      break;
  }
}

function startNewRound(room, now) {
  room.state = "hiding";
  room.roundStartTime = null;
  room.hideEndTime = now + HIDE_TIME;
  room.finishTime = null;
  room.roundIndex++;

  // reset players
  Object.values(room.players).forEach((p) => {
    const pos = randomPosition();
    p.x = pos.x;
    p.y = pos.y;
    p.vx = 0;
    p.vy = 0;
    p.caught = false;
    p.role = "hider";
    p.tranqUntil = 0;

    const stats = getOrCreatePlayerStats(room, p.id, p.name);
    stats.games += 1;
  });

  // spawn / reset bots
  const desiredBots = Math.max(0, Math.min(16, room.config.botCount || 0));
  while (room.bots.length < desiredBots) {
    const id = "bot-" + uuidv4();
    const pos = randomPosition();
    room.bots.push({
      id,
      name: "Bot " + id.slice(0, 4),
      x: pos.x,
      y: pos.y,
      vx: 0,
      vy: 0,
      caught: false,
      role: "hider",
      wanderAngle: Math.random() * Math.PI * 2,
      tranqUntil: 0
    });
  }
  if (room.bots.length > desiredBots) room.bots.length = desiredBots;

  room.bots.forEach((b) => {
    const pos = randomPosition();
    b.x = pos.x;
    b.y = pos.y;
    b.vx = 0;
    b.vy = 0;
    b.caught = false;
    b.role = "hider";
    b.wanderAngle = Math.random() * Math.PI * 2;
    b.tranqUntil = 0;
  });

  // choose seeker from players + bots
  const candidates = [
    ...Object.values(room.players).map((p) => ({ type: "player", id: p.id })),
    ...room.bots.map((b) => ({ type: "bot", id: b.id }))
  ];
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  room.seekerId = chosen.id;

  Object.values(room.players).forEach((p) => {
    p.role = p.id === room.seekerId ? "seeker" : "hider";
    p.caught = false;
    p.tranqUntil = 0;
  });
  room.bots.forEach((b) => {
    b.role = b.id === room.seekerId ? "seeker" : "hider";
    b.caught = false;
    b.tranqUntil = 0;
  });

  // Wake Serum vials
  room.powerups = [];
  for (let i = 0; i < SERUM_PER_ROUND; i++) {
    const pos = randomPosition();
    room.powerups.push({
      id: "serum-" + uuidv4(),
      x: pos.x,
      y: pos.y,
      type: "wake-serum"
    });
  }

  io.to(room.id).emit("roundStarted", {
    seekerId: room.seekerId,
    hideTime: HIDE_TIME,
    roundIndex: room.roundIndex
  });

  console.log(
    `Room ${room.id}: round ${room.roundIndex} started with ${Object.keys(
      room.players
    ).length} players and ${room.bots.length} bots. Seeker: ${room.seekerId}`
  );
}

function hasAnyHider(room) {
  const p = Object.values(room.players).some((p) => p.role === "hider" && !p.caught);
  const b = room.bots.some((b) => b.role === "hider" && !b.caught);
  return p || b;
}

function finishRound(room, now, reason) {
  room.state = "finished";
  room.finishTime = now;

  const seeker = getSeeker(room);

  Object.values(room.players).forEach((p) => {
    const stats = getOrCreatePlayerStats(room, p.id, p.name);
    if (p.role === "hider" && !p.caught) {
      stats.score += SCORE_SURVIVE;
      stats.survived += 1;
    }
  });

  const anyHiderLeft = hasAnyHider(room);
  if (seeker && !anyHiderLeft) {
    const sStats = getOrCreatePlayerStats(room, seeker.id, seeker.name || "Seeker");
    sStats.score += SCORE_FULL_WIPE_BONUS;
  }

  io.to(room.id).emit("roundFinished", { reason });
}

// ============ STATUS + WAKE SERUM ============
function updateStatusAndSerums(room, now) {
  Object.values(room.players).forEach((p) => {
    if (p.tranqUntil && p.tranqUntil <= now) p.tranqUntil = 0;
  });
  room.bots.forEach((b) => {
    if (b.tranqUntil && b.tranqUntil <= now) b.tranqUntil = 0;
  });

  if (!room.powerups || !room.powerups.length) return;

  const remaining = [];
  room.powerups.forEach((pu) => {
    if (pu.type !== "wake-serum") {
      remaining.push(pu);
      return;
    }
    let picked = false;
    Object.values(room.players).forEach((p) => {
      if (picked) return;
      const d = dist(p, pu);
      if (d <= SERUM_PICKUP_RADIUS) {
        p.tranqUntil = 0;
        picked = true;
      }
    });
    if (!picked) remaining.push(pu);
  });
  room.powerups = remaining;
}

// ============ MOVEMENT ============
function applyInput(p, now) {
  if (p.caught) return;

  let speed = PLAYER_SPEED;
  if (p.tranqUntil && p.tranqUntil > now) speed *= TRANQ_SLOW_MULT;

  let vx = 0;
  let vy = 0;
  if (p.input && p.input.up) vy -= 1;
  if (p.input && p.input.down) vy += 1;
  if (p.input && p.input.left) vx -= 1;
  if (p.input && p.input.right) vx += 1;

  const len = Math.sqrt(vx * vx + vy * vy) || 1;
  vx = (vx / len) * speed;
  vy = (vy / len) * speed;

  p.x = Math.max(0, Math.min(MAP_WIDTH, p.x + vx));
  p.y = Math.max(0, Math.min(MAP_HEIGHT, p.y + vy));
}

// ============ BOT AI ============
function updateBots(room, now) {
  const seeker = getSeeker(room);
  const players = Object.values(room.players);

  room.bots.forEach((bot) => {
    if (bot.caught) return;

    let speed = BOT_SPEED;
    if (bot.tranqUntil && bot.tranqUntil > now) speed *= TRANQ_SLOW_MULT;

    if (bot.role === "hider") {
      let dx = 0,
        dy = 0;
      if (seeker) {
        const d = dist(bot, seeker);
        if (d < 400) {
          dx = bot.x - seeker.x;
          dy = bot.y - seeker.y;
        } else {
          if (Math.random() < 0.02) bot.wanderAngle += Math.random() - 0.5;
          dx = Math.cos(bot.wanderAngle);
          dy = Math.sin(bot.wanderAngle);
        }
      } else {
        if (Math.random() < 0.03) bot.wanderAngle += Math.random() - 0.5;
        dx = Math.cos(bot.wanderAngle);
        dy = Math.sin(bot.wanderAngle);
      }
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      bot.x = Math.max(0, Math.min(MAP_WIDTH, bot.x + (dx / len) * speed));
      bot.y = Math.max(0, Math.min(MAP_HEIGHT, bot.y + (dy / len) * speed));
    } else if (bot.role === "seeker") {
      const targets = [
        ...players.filter((p) => p.role === "hider" && !p.caught),
        ...room.bots.filter((b) => b.role === "hider" && !b.caught)
      ];
      if (!targets.length) return;

      let closest = null;
      let minD = Infinity;
      targets.forEach((t) => {
        const d = dist(bot, t);
        if (d < minD) {
          minD = d;
          closest = t;
        }
      });

      if (closest) {
        const dx = closest.x - bot.x;
        const dy = closest.y - bot.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        bot.x = Math.max(0, Math.min(MAP_WIDTH, bot.x + (dx / len) * speed));
        bot.y = Math.max(0, Math.min(MAP_HEIGHT, bot.y + (dy / len) * speed));
      }
    }
  });
}

function getSeeker(room) {
  const fromPlayers = Object.values(room.players).find((p) => p.id === room.seekerId);
  if (fromPlayers) return fromPlayers;
  return room.bots.find((b) => b.id === room.seekerId) || null;
}

// ============ TAGGING ============
function handleTagging(room) {
  const seeker = getSeeker(room);
  if (!seeker) return;

  const TAG_RADIUS = 40;

  Object.values(room.players).forEach((p) => {
    if (p.role === "hider" && !p.caught && dist(seeker, p) < TAG_RADIUS) {
      catchHider(room, seeker, p);
    }
  });

  room.bots.forEach((b) => {
    if (b.role === "hider" && !b.caught && dist(seeker, b) < TAG_RADIUS) {
      catchBot(room, seeker, b);
    }
  });
}

function catchHider(room, seeker, hider) {
  if (hider.caught) return;
  hider.caught = true;
  hider.tranqUntil = 0;

  const sStats = getOrCreatePlayerStats(room, seeker.id, seeker.name || "Seeker");
  sStats.score += SCORE_TAG;
  sStats.tags += 1;

  const hStats = getOrCreatePlayerStats(room, hider.id, hider.name);
  hStats.score -= SCORE_CAUGHT_PENALTY;

  io.to(room.id).emit("playerTagged", { id: hider.id, by: seeker.id });
}

function catchBot(room, seeker, bot) {
  if (bot.caught) return;
  bot.caught = true;
  bot.tranqUntil = 0;

  const sStats = getOrCreatePlayerStats(room, seeker.id, seeker.name || "Seeker");
  sStats.score += SCORE_TAG;
  sStats.tags += 1;

  io.to(room.id).emit("botTagged", { id: bot.id, by: seeker.id });
}

// ============ SHOOTING ============
function handleShot(room, shooterId, shotX, shotY) {
  // Validation
  if (!isValidNumber(shotX) || !isValidNumber(shotY)) {
    console.warn(`Invalid shot coords from ${shooterId} in room ${room.id}:`, shotX, shotY);
    return;
  }

  const seeker = getSeeker(room);
  if (!seeker || seeker.id !== shooterId) return;
  if (room.state !== "seeking") return;

  const impact = { x: shotX, y: shotY };

  let closestHider = null;
  let closestD = Infinity;
  Object.values(room.players).forEach((p) => {
    if (p.role === "hider" && !p.caught) {
      const d = dist(impact, p);
      if (d < closestD) {
        closestD = d;
        closestHider = p;
      }
    }
  });

  let closestBot = null;
  let closestBotD = Infinity;
  room.bots.forEach((b) => {
    if (b.role === "hider" && !b.caught) {
      const d = dist(impact, b);
      if (d < closestBotD) {
        closestBotD = d;
        closestBot = b;
      }
    }
  });

  let target = null;
  let isBot = false;

  if (closestHider && closestD <= SHOOT_RADIUS) {
    target = closestHider;
  }
  if (closestBot && closestBotD <= SHOOT_RADIUS && closestBotD < closestD) {
    target = closestBot;
    isBot = true;
  }

  if (target) {
    const now = Date.now();

    // first hit → tranquilize, second within window → captured
    if (!target.tranqUntil || target.tranqUntil <= now) {
      target.tranqUntil = now + TRANQ_DURATION;
      io.to(room.id).emit("tranqApplied", {
        id: target.id,
        isBot,
        duration: TRANQ_DURATION
      });
    } else {
      if (isBot) catchBot(room, seeker, target);
      else catchHider(room, seeker, target);
    }
  }

  io.to(room.id).emit("shotFired", {
    shooterId,
    x: shotX,
    y: shotY
  });
}

// ============ SNAPSHOT ============
function buildSnapshot(room) {
  const leaderboard = Object.values(room.scores)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  return {
    state: room.state,
    seekerId: room.seekerId,
    players: Object.values(room.players).map((p) => ({
      id: p.id,
      name: p.name,
      x: p.x,
      y: p.y,
      role: p.role,
      caught: p.caught,
      tranq: !!(p.tranqUntil && p.tranqUntil > Date.now())
    })),
    bots: room.bots.map((b) => ({
      id: b.id,
      name: b.name,
      x: b.x,
      y: b.y,
      role: b.role,
      caught: b.caught,
      tranq: !!(b.tranqUntil && b.tranqUntil > Date.now())
    })),
    map: room.map,
    hideTimeRemaining:
      room.state === "hiding" ? Math.max(0, room.hideEndTime - Date.now()) : 0,
    roundTimeRemaining:
      room.state === "seeking" && room.roundStartTime
        ? Math.max(0, room.roundStartTime + ROUND_TIME - Date.now())
        : 0,
    leaderboard,
    roundIndex: room.roundIndex,
    powerups: (room.powerups || []).map((p) => ({
      id: p.id,
      x: p.x,
      y: p.y,
      type: p.type
    }))
  };
}

// ============ SOCKET HANDLERS ============
io.on("connection", (socket) => {
  console.log("Client connected", socket.id);

  socket.on("joinGame", (payload) => {
    try {
      if (!payload || typeof payload !== 'object') {
        socket.emit("joinError", { message: "Invalid join payload." });
        return;
      }
      const requestedRaw = payload.name;
      const requested = sanitizeRequestedName(requestedRaw);
      const roomId = payload.roomId && typeof payload.roomId === 'string' && payload.roomId.trim() ? payload.roomId.trim() : "default";
      const options = payload.options || {};
      const botCount = typeof options.botCount === 'number' ? clamp(options.botCount, 0, 16) : undefined;

      // enforce hash suffix policy & reserved names
      let candidate = ensureHashSuffix(requested);
      const base = nameBase(candidate);

      if (isReservedNameEffective(candidate)) {
        // reserved names are blocked unless purchased/unlocked
        socket.emit("joinError", { message: "This display name is reserved. Choose another name." });
        return;
      }

      const finalRoomId = roomId;

      if (!rooms[finalRoomId]) {
        const cfg = {
          botCount: typeof botCount === "number" ? botCount : 4
        };
        createRoom(finalRoomId, cfg);
      }
      const room = rooms[finalRoomId];

      if (Object.keys(room.players).length >= room.config.maxPlayers) {
        socket.emit("joinError", { message: "Room is full." });
        return;
      }

      // ensure unique name inside room
      candidate = makeUniqueNameInRoom(room, candidate);

      const pos = randomPosition();
      room.players[socket.id] = {
        id: socket.id,
        name: candidate,
        x: pos.x,
        y: pos.y,
        vx: 0,
        vy: 0,
        role: "hider",
        caught: false,
        input: { up: false, down: false, left: false, right: false },
        tranqUntil: 0
      };

      getOrCreatePlayerStats(room, socket.id, candidate);

      socket.join(finalRoomId);
      socket.roomId = finalRoomId;

      socket.emit("joinedRoom", {
        roomId: finalRoomId,
        playerId: socket.id,
        config: room.config,
        name: candidate
      });
      console.log(`Player ${socket.id} (${candidate}) joined room ${finalRoomId}`);
    } catch (err) {
      console.error("joinGame handler error:", err);
      socket.emit("joinError", { message: "Server error while joining." });
    }
  });

  socket.on("input", (input) => {
    try {
      const roomId = socket.roomId;
      if (!roomId || !rooms[roomId]) return;

      const player = rooms[roomId].players[socket.id];
      if (!player || player.caught) return;

      // Basic shape validation
      const newInput = {
        up: !!(input && input.up),
        down: !!(input && input.down),
        left: !!(input && input.left),
        right: !!(input && input.right)
      };
      player.input = newInput;
    } catch (err) {
      console.error("input handler error:", err);
    }
  });

  socket.on("shoot", (payload) => {
    try {
      const roomId = socket.roomId;
      if (!roomId || !rooms[roomId]) return;

      // payload may be { x, y } — validate
      let x = null, y = null;
      if (payload && typeof payload === 'object') {
        x = Number(payload.x);
        y = Number(payload.y);
      }

      if (!isValidNumber(x) || !isValidNumber(y)) {
        console.warn(`Malformed shoot payload from ${socket.id} in room ${roomId}:`, payload);
        return;
      }

      handleShot(rooms[roomId], socket.id, x, y);
    } catch (err) {
      console.error("shoot handler error:", err);
    }
  });

  socket.on("disconnect", () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      delete rooms[roomId].players[socket.id];
      console.log(`Player ${socket.id} left room ${roomId}`);
    } else {
      console.log("Client disconnected", socket.id);
    }
  });
});

server.listen(PORT, async () => {
  console.log(`Hide To Survive backend listening on port ${PORT}`);
  await loadStore();
});

// ============ Basic HTTP routes for health / debug ============
app.get("/", (req, res) => {
  res.send("Hide To Survive backend is running.");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", now: Date.now(), rooms: Object.keys(rooms).length, uptime: process.uptime() });
});

/**
 * Metrics endpoint - open (non-sensitive). Returns rooms summary.
 */
app.get("/metrics", (req, res) => {
  const roomSummaries = Object.values(rooms).map(r => ({
    id: r.id,
    players: Object.keys(r.players).length,
    bots: r.bots.length,
    state: r.state,
    roundIndex: r.roundIndex,
    createdAt: r.createdAt
  }));
  const totalPlayers = Object.values(rooms).reduce((acc, r) => acc + Object.keys(r.players).length, 0);
  res.json({
    status: "ok",
    serverTime: Date.now(),
    rooms: roomSummaries,
    totalRooms: Object.keys(rooms).length,
    totalPlayers
  });
});

// ============ ADMIN ROUTES (protected by ADMIN_TOKEN) ============
function checkAdminToken(req, res) {
  const token = (req.headers['x-admin-token'] || '').trim();
  if (!ADMIN_TOKEN) {
    res.status(403).json({ ok: false, error: 'Admin token not configured on server.' });
    return false;
  }
  if (!token || token !== ADMIN_TOKEN) {
    res.status(401).json({ ok: false, error: 'Invalid admin token' });
    return false;
  }
  return true;
}

/**
 * POST /admin/clear-room
 * body: { roomId: 'default' }
 * header: x-admin-token: <token>
 */
app.post('/admin/clear-room', (req, res) => {
  try {
    if (!checkAdminToken(req, res)) return;
    const roomId = req.body && typeof req.body.roomId === 'string' ? req.body.roomId : null;
    if (!roomId) return res.status(400).json({ ok: false, error: 'Missing roomId' });
    if (!rooms[roomId]) return res.status(404).json({ ok: false, error: 'Room not found' });

    // Notify sockets in room (if any) that room is cleared, then remove
    const sids = io.sockets.adapter.rooms.get(roomId);
    if (sids && sids.size) {
      for (const sid of sids) {
        const sock = io.sockets.sockets.get(sid);
        if (sock) {
          try { sock.leave(roomId); sock.emit('roomCleared', { roomId }); } catch (e) { /* ignore */ }
        }
      }
    }
    delete rooms[roomId];
    console.log(`Admin cleared room ${roomId}`);
    return res.json({ ok: true, cleared: roomId });
  } catch (err) {
    console.error('/admin/clear-room error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/**
 * POST /admin/clear-all
 * header: x-admin-token: <token>
 */
app.post('/admin/clear-all', (req, res) => {
  try {
    if (!checkAdminToken(req, res)) return;
    const roomIds = Object.keys(rooms);
    roomIds.forEach(roomId => {
      const sids = io.sockets.adapter.rooms.get(roomId);
      if (sids && sids.size) {
        for (const sid of sids) {
          const sock = io.sockets.sockets.get(sid);
          if (sock) {
            try { sock.leave(roomId); sock.emit('roomCleared', { roomId }); } catch (e) {}
          }
        }
      }
      delete rooms[roomId];
    });
    console.log('Admin cleared all rooms');
    return res.json({ ok: true, cleared: roomIds.length });
  } catch (err) {
    console.error('/admin/clear-all error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/**
 * GET /admin/reserved-names
 * header: x-admin-token: <token>
 */
app.get('/admin/reserved-names', (req, res) => {
  try {
    if (!checkAdminToken(req, res)) return;
    res.json({ ok: true, reservedNames: RESERVED_NAMES });
  } catch (err) {
    console.error('/admin/reserved-names error:', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/**
 * GET /admin/purchased-names
 * header: x-admin-token: <token>
 * returns purchased/unlocked names map
 */
app.get('/admin/purchased-names', (req, res) => {
  try {
    if (!checkAdminToken(req, res)) return;
    res.json({ ok: true, purchased: store.purchased });
  } catch (err) {
    console.error('/admin/purchased-names error:', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/**
 * POST /admin/grant-name
 * header: x-admin-token: <token>
 * body: { base: "Todd", owner: "optional-owner-id-or-email" }
 * Grants (persists) the base name so it is no longer treated as reserved.
 */
app.post('/admin/grant-name', async (req, res) => {
  try {
    if (!checkAdminToken(req, res)) return;
    const baseRaw = req.body && typeof req.body.base === 'string' ? req.body.base.trim() : null;
    if (!baseRaw) return res.status(400).json({ ok: false, error: 'Missing base' });
    const base = baseRaw.split('#')[0].trim().toLowerCase();
    const owner = req.body && req.body.owner ? String(req.body.owner).trim() : 'admin-grant';
    store.purchased[base] = { owner, grantedAt: Date.now() };
    await saveStore();
    console.log(`Admin granted name: ${base} -> ${owner}`);
    return res.json({ ok: true, base, owner });
  } catch (err) {
    console.error('/admin/grant-name error:', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/**
 * POST /admin/revoke-name
 * header: x-admin-token: <token>
 * body: { base: "Todd" }
 * Removes previously granted purchased name.
 */
app.post('/admin/revoke-name', async (req, res) => {
  try {
    if (!checkAdminToken(req, res)) return;
    const baseRaw = req.body && typeof req.body.base === 'string' ? req.body.base.trim() : null;
    if (!baseRaw) return res.status(400).json({ ok: false, error: 'Missing base' });
    const base = baseRaw.split('#')[0].trim().toLowerCase();
    if (store.purchased[base]) {
      delete store.purchased[base];
      await saveStore();
      console.log(`Admin revoked purchased name: ${base}`);
      return res.json({ ok: true, base });
    } else {
      return res.status(404).json({ ok: false, error: 'Not found' });
    }
  } catch (err) {
    console.error('/admin/revoke-name error:', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ============ Process handlers ============
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at:', p, 'reason:', reason);
});
