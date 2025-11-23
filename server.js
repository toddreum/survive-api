// server.js
// Survive — Online backend with SSE private rooms + stats + animals.
// Runs on Render at https://survive-api.onrender.com

const path = require("path");
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { randomBytes } = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// -----------------------------
// Middleware
// -----------------------------
app.use(
  cors({
    origin: true, // allow all origins or tighten later
    credentials: true
  })
);
app.use(bodyParser.json());

// -----------------------------
// Base data: animals & decoys
// -----------------------------
const REAL_ANIMALS = [
  { name: "Lion", emoji: "🦁" },
  { name: "Tiger", emoji: "🐯" },
  { name: "Elephant", emoji: "🐘" },
  { name: "Giraffe", emoji: "🦒" },
  { name: "Zebra", emoji: "🦓" },
  { name: "Rhino", emoji: "🦏" },
  { name: "Hippo", emoji: "🦛" },
  { name: "Fox", emoji: "🦊" },
  { name: "Wolf", emoji: "🐺" },
  { name: "Kangaroo", emoji: "🦘" },
  { name: "Panda", emoji: "🐼" },
  { name: "Koala", emoji: "🐨" },
  { name: "Monkey", emoji: "🐒" },
  { name: "Eagle", emoji: "🦅" }
];

const DECOYS = [
  "Glitter Yak",
  "Thunder Llama",
  "Pixel Serpent",
  "Nebula Rat",
  "Turbo Beetle",
  "Ghost Pony",
  "Cloud Shark",
  "Laser Sloth",
  "Chrono Owl",
  "Magnet Gecko"
];

// -----------------------------
// Helpers
// -----------------------------
function normalizeAnimalName(raw) {
  if (!raw) return "";
  const t = String(raw).trim();
  if (!t) return "";
  return t
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function isRealAnimalName(name) {
  return REAL_ANIMALS.some((a) => a.name === name);
}

function isDecoyName(name) {
  return DECOYS.includes(name);
}

function createRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function createPlayerId() {
  return randomBytes(8).toString("hex");
}

// -----------------------------
// In-memory storage
// -----------------------------
const SESSIONS = [];
const MAX_SESSIONS = 500;

// Room structure:
// {
//   code,
//   createdAt,
//   hostId,
//   players: Map<playerId, { id,name,animal,emoji,secretNumber,isBot }>
//   lobbyLocked: boolean,
//   gameStarted: boolean,
//   matchSeconds: number,
//   game: {
//     aardvarkScore,
//     chainCount,
//     currentCaller,
//     pendingSurvival,
//     matchSecondsRemaining,
//     survivalDeadlineMs,
//     history: [{ text,type,ts }]
//   },
//   sseClients: Set<res>,
//   interval: NodeJS.Timer
// }
const rooms = new Map();

function snapshotRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    lobbyLocked: room.lobbyLocked,
    gameStarted: room.gameStarted,
    matchSeconds: room.matchSeconds,
    players: Array.from(room.players.values()).map((p) => ({
      id: p.id,
      name: p.name,
      animal: p.animal,
      emoji: p.emoji,
      isBot: !!p.isBot
    })),
    game: room.game
      ? {
          aardvarkScore: room.game.aardvarkScore,
          chainCount: room.game.chainCount,
          currentCaller: room.game.currentCaller,
          pendingSurvival: room.game.pendingSurvival,
          matchSecondsRemaining: room.game.matchSecondsRemaining,
          history: room.game.history
        }
      : null
  };
}

function ensureRoomInterval(room) {
  if (room.interval) return;

  room.interval = setInterval(() => {
    const now = Date.now();
    if (room.gameStarted && room.game) {
      // match time
      if (room.game.matchSecondsRemaining > 0) {
        room.game.matchSecondsRemaining -= 1;
        if (room.game.matchSecondsRemaining <= 0) {
          room.game.matchSecondsRemaining = 0;
          room.gameStarted = false;
          addGameHistory(room, "Match time is up. Final Aardvark score: " + room.game.aardvarkScore, "info");
          broadcastRoom(room);
          return;
        }
      }
      // survival timeout
      if (
        room.game.pendingSurvival &&
        room.game.survivalDeadlineMs &&
        now >= room.game.survivalDeadlineMs
      ) {
        handleSurvivalTimeout(room);
      }
    }
    broadcastRoom(room, true); // lightweight heartbeat update
  }, 1000);
}

function broadcastRoom(room, heartbeatOnly = false) {
  if (!room.sseClients || room.sseClients.size === 0) return;
  const payload = JSON.stringify({
    type: heartbeatOnly ? "heartbeat" : "state",
    room: snapshotRoom(room)
  });
  const data = `data: ${payload}\n\n`;
  for (const res of room.sseClients) {
    try {
      res.write(data);
    } catch (err) {
      // stale client
    }
  }
}

function addGameHistory(room, text, type = "neutral") {
  if (!room.game) return;
  const entry = {
    text,
    type,
    ts: new Date().toISOString()
  };
  room.game.history.push(entry);
  if (room.game.history.length > 200) {
    room.game.history.splice(0, room.game.history.length - 200);
  }
}

// Called when pendingSurvival times out
function handleSurvivalTimeout(room) {
  if (!room.game || !room.game.pendingSurvival) return;
  const animalName = room.game.pendingSurvival;
  room.game.aardvarkScore += 5;
  room.game.chainCount = 0;
  addGameHistory(
    room,
    `${animalName} fails to call in time. Aardvark tags them for +5.`,
    "bad"
  );
  room.game.pendingSurvival = null;
  room.game.survivalDeadlineMs = null;
  room.game.currentCaller = "Aardvark";
}

// Clean room if empty
function maybeCleanupRoom(room) {
  if (room.sseClients.size === 0 && room.players.size === 0) {
    if (room.interval) clearInterval(room.interval);
    rooms.delete(room.code);
  }
}

// -----------------------------
// API: health & animals
// -----------------------------
app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "Survive API running." });
});

app.get("/api/game/animals", (req, res) => {
  res.json({
    real: REAL_ANIMALS,
    decoys: DECOYS
  });
});

// -----------------------------
// API: sessions & leaderboard
// -----------------------------
app.post("/api/game/session", (req, res) => {
  const {
    playerName = "Unknown",
    score = 0,
    maxChain = 0,
    matchSeconds = 0,
    endedAt = new Date().toISOString(),
    endReason = "",
    history = []
  } = req.body || {};
  const entry = {
    id: Date.now() + Math.random(),
    playerName,
    score: Number(score) || 0,
    maxChain: Number(maxChain) || 0,
    matchSeconds: Number(matchSeconds) || 0,
    endedAt,
    endReason,
    history
  };
  SESSIONS.push(entry);
  if (SESSIONS.length > MAX_SESSIONS) {
    SESSIONS.splice(0, SESSIONS.length - MAX_SESSIONS);
  }
  res.json({ ok: true });
});

app.get("/api/game/leaderboard", (req, res) => {
  const sorted = [...SESSIONS].sort((a, b) => b.score - a.score);
  const entries = sorted.slice(0, 100).map((s) => ({
    playerName: s.playerName,
    score: s.score,
    maxChain: s.maxChain
  }));
  res.json({ entries });
});

// -----------------------------
// API: rooms (create/join/lock/state/action)
// -----------------------------
app.post("/api/rooms/create", (req, res) => {
  let code;
  do {
    code = createRoomCode();
  } while (rooms.has(code));

  const playerId = createPlayerId();
  const now = Date.now();

  const room = {
    code,
    createdAt: now,
    hostId: playerId,
    players: new Map(),
    lobbyLocked: false,
    gameStarted: false,
    matchSeconds: 300,
    game: null,
    sseClients: new Set(),
    interval: null
  };

  rooms.set(code, room);
  ensureRoomInterval(room);

  room.players.set(playerId, {
    id: playerId,
    name: "Host",
    animal: "",
    emoji: "🐾",
    secretNumber: null,
    isBot: false
  });

  res.json({
    ok: true,
    roomCode: code,
    playerId,
    room: snapshotRoom(room)
  });
});

app.post("/api/rooms/join", (req, res) => {
  const { roomCode, name, animal, secretNumber, isBot } = req.body || {};
  if (!roomCode) {
    return res.status(400).json({ ok: false, error: "roomCode is required" });
  }
  const room = rooms.get(roomCode);
  if (!room) {
    return res.status(404).json({ ok: false, error: "Room not found" });
  }
  if (room.lobbyLocked) {
    return res
      .status(400)
      .json({ ok: false, error: "Lobby is locked, cannot join." });
  }

  const playerId = createPlayerId();
  const normalizedName = (name || "").trim() || "Player";
  const normalizedAnimal = normalizeAnimalName(animal || "");
  const emoji =
    REAL_ANIMALS.find((a) => a.name === normalizedAnimal)?.emoji || "🐾";
  const num = secretNumber != null ? Number(secretNumber) : null;

  room.players.set(playerId, {
    id: playerId,
    name: normalizedName,
    animal: normalizedAnimal,
    emoji,
    secretNumber: num,
    isBot: !!isBot
  });

  res.json({
    ok: true,
    roomCode,
    playerId,
    room: snapshotRoom(room)
  });
});

app.post("/api/rooms/lock", (req, res) => {
  const { roomCode, playerId, matchMinutes } = req.body || {};
  if (!roomCode || !playerId) {
    return res
      .status(400)
      .json({ ok: false, error: "roomCode and playerId required" });
  }
  const room = rooms.get(roomCode);
  if (!room) {
    return res.status(404).json({ ok: false, error: "Room not found" });
  }
  if (room.hostId !== playerId) {
    return res.status(403).json({ ok: false, error: "Only host can lock lobby" });
  }
  if (room.players.size < 2) {
    return res
      .status(400)
      .json({ ok: false, error: "Need at least 2 players to start" });
  }

  room.lobbyLocked = true;
  room.matchSeconds = matchMinutes
    ? Math.max(60, Math.min(Number(matchMinutes) * 60, 1800))
    : 300;

  // pick first Aardvark by number closest to 20
  let firstPlayer = null;
  let bestDiff = Infinity;
  for (const p of room.players.values()) {
    if (p.secretNumber == null) continue;
    const diff = Math.abs(20 - p.secretNumber);
    if (
      firstPlayer === null ||
      diff < bestDiff ||
      (diff === bestDiff && p.secretNumber > firstPlayer.secretNumber)
    ) {
      firstPlayer = p;
      bestDiff = diff;
    }
  }

  // game state
  room.gameStarted = true;
  room.game = {
    aardvarkScore: 0,
    chainCount: 0,
    currentCaller: "Aardvark",
    pendingSurvival: null,
    matchSecondsRemaining: room.matchSeconds,
    survivalDeadlineMs: null,
    history: []
  };

  if (firstPlayer) {
    addGameHistory(
      room,
      `${firstPlayer.name} is closest to 20 (${firstPlayer.secretNumber}) and starts as Aardvark in the middle.`,
      "info"
    );
  } else {
    addGameHistory(
      room,
      "Lobby locked with no numbers; Aardvark starts in the middle by default.",
      "info"
    );
  }

  ensureRoomInterval(room);
  broadcastRoom(room);
  res.json({ ok: true, room: snapshotRoom(room) });
});

app.get("/api/rooms/:code/state", (req, res) => {
  const code = req.params.code;
  const room = rooms.get(code);
  if (!room) {
    return res.status(404).json({ ok: false, error: "Room not found" });
  }
  res.json({ ok: true, room: snapshotRoom(room) });
});

// Submit a call: "Caller calls Target"
app.post("/api/rooms/action", (req, res) => {
  const { roomCode, playerId, targetAnimal } = req.body || {};
  if (!roomCode || !playerId) {
    return res
      .status(400)
      .json({ ok: false, error: "roomCode and playerId required" });
  }
  const room = rooms.get(roomCode);
  if (!room) {
    return res.status(404).json({ ok: false, error: "Room not found" });
  }
  if (!room.gameStarted || !room.game) {
    return res
      .status(400)
      .json({ ok: false, error: "Game not started in this room" });
  }

  const player = room.players.get(playerId);
  if (!player) {
    return res.status(403).json({ ok: false, error: "Unknown player" });
  }

  const targetName = normalizeAnimalName(targetAnimal || "");
  if (!targetName) {
    return res
      .status(400)
      .json({ ok: false, error: "targetAnimal is required" });
  }

  const sentence = `${room.game.currentCaller} calls ${targetName}!`;

  const isReal = isRealAnimalName(targetName);
  const isDecoy = isDecoyName(targetName);
  const validReal = isReal && !isDecoy;

  // If invalid or decoy → buzzer, penalty, chain reset to Aardvark
  if (!validReal) {
    addGameHistory(
      room,
      sentence + " (decoy / invalid). Buzzer, −10 and chain snaps back to Aardvark.",
      "bad"
    );
    // If caller was under survival, Aardvark also gets +5.
    if (
      room.game.pendingSurvival &&
      room.game.pendingSurvival === room.game.currentCaller
    ) {
      room.game.aardvarkScore += 5;
      addGameHistory(
        room,
        `${room.game.currentCaller} used a decoy while trying to survive. Aardvark tags them for +5.`,
        "bad"
      );
    }
    room.game.aardvarkScore = Math.max(0, room.game.aardvarkScore - 10);
    room.game.chainCount = 0;
    room.game.pendingSurvival = null;
    room.game.survivalDeadlineMs = null;
    room.game.currentCaller = "Aardvark";

    broadcastRoom(room);
    return res.json({ ok: true, room: snapshotRoom(room) });
  }

  // Valid call
  addGameHistory(room, sentence, "neutral");

  if (
    room.game.pendingSurvival &&
    room.game.pendingSurvival === room.game.currentCaller
  ) {
    // animal survived the tag
    room.game.aardvarkScore -= 5;
    if (room.game.aardvarkScore < 0) room.game.aardvarkScore = 0;
    room.game.chainCount += 1;
    addGameHistory(
      room,
      `${room.game.pendingSurvival} survives Aardvark and keeps the chain alive. −5 points for Aardvark.`,
      "good"
    );
  }

  room.game.pendingSurvival = targetName;
  room.game.survivalDeadlineMs = Date.now() + 10000; // 10s
  room.game.currentCaller = targetName;

  broadcastRoom(room);
  res.json({ ok: true, room: snapshotRoom(room) });
});

// -----------------------------
// SSE stream: /api/rooms/:code/stream
// -----------------------------
app.get("/api/rooms/:code/stream", (req, res) => {
  const code = req.params.code;
  const room = rooms.get(code);
  if (!room) {
    res.writeHead(404, {
      "Content-Type": "text/plain"
    });
    res.end("Room not found");
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  res.write("retry: 2000\n\n");

  room.sseClients.add(res);

  // Send initial state
  const initialPayload = JSON.stringify({
    type: "state",
    room: snapshotRoom(room)
  });
  res.write(`data: ${initialPayload}\n\n`);

  const heartbeatInterval = setInterval(() => {
    try {
      res.write(`data: ${JSON.stringify({ type: "ping" })}\n\n`);
    } catch (err) {
      // ignore, cleanup in 'close'
    }
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeatInterval);
    room.sseClients.delete(res);
    maybeCleanupRoom(room);
  });
});

// -----------------------------
// Static (optional) — if you ever deploy frontend with this server
// -----------------------------
const PUBLIC_DIR = path.join(__dirname, "public_html");
app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => {
  res.send("Survive API up. Frontend is served from cPanel.");
});

// -----------------------------
// Start server
// -----------------------------
app.listen(PORT, () => {
  console.log(`Survive API listening on http://localhost:${PORT}`);
});
