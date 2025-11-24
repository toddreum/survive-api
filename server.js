// Simple SURVIVE backend with in-memory rooms + SSE
// Deploy this on Render as survive-api.onrender.com

const express = require("express");
const cors = require("cors");
const { randomUUID } = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// In-memory rooms (ephemeral)
const rooms = new Map(); // code -> room

function createRoom() {
  const code = Math.random().toString(36).slice(2, 7).toUpperCase();
  const room = {
    code,
    hostId: null,
    players: [],
    gameStarted: false,
    game: null,
    sseClients: new Set()
  };
  rooms.set(code, room);
  return room;
}

function broadcastRoom(room) {
  const payload = JSON.stringify({
    type: "state",
    room: {
      code: room.code,
      hostId: room.hostId,
      players: room.players,
      gameStarted: room.gameStarted,
      game: room.game
    }
  });
  for (const res of room.sseClients) {
    res.write(`data: ${payload}\n\n`);
  }
}

app.get("/", (req, res) => {
  res.send("SURVIVE API is running.");
});

// Create room
app.post("/api/rooms/create", (req, res) => {
  const room = createRoom();
  const playerId = randomUUID();
  room.hostId = playerId;
  room.players.push({
    id: playerId,
    name: "Host",
    animal: null,
    secretNumber: null,
    isBot: false
  });
  broadcastRoom(room);
  res.json({
    ok: true,
    roomCode: room.code,
    playerId,
    room
  });
});

// Join room
app.post("/api/rooms/join", (req, res) => {
  const { roomCode, name, animal, secretNumber, isBot } = req.body || {};
  const code = (roomCode || "").toUpperCase();
  const room = rooms.get(code);
  if (!room) {
    return res.json({ ok: false, error: "Room not found." });
  }
  if (room.gameStarted) {
    return res.json({ ok: false, error: "Game already started." });
  }

  const playerId = randomUUID();
  room.players.push({
    id: playerId,
    name: name || "Player",
    animal: animal || null,
    secretNumber: secretNumber || null,
    isBot: !!isBot
  });

  broadcastRoom(room);
  res.json({
    ok: true,
    playerId,
    room
  });
});

// Lock lobby & start game
app.post("/api/rooms/lock", (req, res) => {
  const { roomCode, playerId, matchMinutes } = req.body || {};
  const code = (roomCode || "").toUpperCase();
  const room = rooms.get(code);
  if (!room) {
    return res.json({ ok: false, error: "Room not found." });
  }
  if (room.hostId !== playerId) {
    return res.json({ ok: false, error: "Only host can start the game." });
  }
  if (room.gameStarted) {
    return res.json({ ok: false, error: "Game already started." });
  }

  const minutes = Math.max(1, Math.min(30, Number(matchMinutes || 5)));

  room.gameStarted = true;
  room.game = {
    matchSecondsRemaining: minutes * 60,
    aardvarkScore: 0,
    chainCount: 0,
    currentCaller: "Aardvark",
    pendingSurvival: null,
    survivalDeadline: null,
    history: []
  };

  broadcastRoom(room);
  res.json({ ok: true, room });
});

// SSE stream for room
app.get("/api/rooms/:code/stream", (req, res) => {
  const code = (req.params.code || "").toUpperCase();
  const room = rooms.get(code);
  if (!room) {
    res.status(404).send("Room not found");
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  room.sseClients.add(res);

  // send initial state
  const payload = JSON.stringify({
    type: "state",
    room: {
      code: room.code,
      hostId: room.hostId,
      players: room.players,
      gameStarted: room.gameStarted,
      game: room.game
    }
  });
  res.write(`data: ${payload}\n\n`);

  req.on("close", () => {
    room.sseClients.delete(res);
  });
});

// Player action: call animal (online mode logic kept simple)
app.post("/api/rooms/action", (req, res) => {
  const { roomCode, playerId, targetAnimal } = req.body || {};
  const code = (roomCode || "").toUpperCase();
  const room = rooms.get(code);
  if (!room || !room.gameStarted || !room.game) {
    return res.json({ ok: false, error: "Game not active." });
  }

  const player = room.players.find((p) => p.id === playerId);
  if (!player) {
    return res.json({ ok: false, error: "Player not in room." });
  }

  const name = (targetAnimal || "").trim();
  if (!name) {
    return res.json({ ok: false, error: "No animal name." });
  }

  // Minimal: just log the call and set pendingSurvival on server
  const norm = name
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");

  room.game.currentCaller = player.animal || player.name || "Player";
  room.game.pendingSurvival = norm;
  room.game.survivalDeadline = Date.now() + 10000;

  room.game.history.push({
    type: "neutral",
    text: `${room.game.currentCaller} calls ${norm}!`
  });

  broadcastRoom(room);
  res.json({ ok: true, room });
});

// Simple match timer tick for all rooms (every second)
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (!room.gameStarted || !room.game) continue;
    if (room.game.matchSecondsRemaining <= 0) continue;

    room.game.matchSecondsRemaining -= 1;
    if (room.game.matchSecondsRemaining < 0) {
      room.game.matchSecondsRemaining = 0;
    }

    // Survival timeout (no BONK scoring logic here yet; kept simple)
    if (room.game.pendingSurvival && room.game.survivalDeadline) {
      if (now >= room.game.survivalDeadline) {
        room.game.history.push({
          type: "info",
          text: `${room.game.pendingSurvival} ran out of time. (Online mode: host resolves rules.)`
        });
        room.game.pendingSurvival = null;
        room.game.survivalDeadline = null;
      }
    }

    broadcastRoom(room);
  }
}, 1000);

app.listen(PORT, () => {
  console.log("SURVIVE API listening on port", PORT);
});
