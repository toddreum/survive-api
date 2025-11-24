// server.js
// Minimal SURVIVE API server for Render
// Endpoints used by the front-end at https://survive-api.onrender.com

"use strict";

const express = require("express");
const cors = require("cors");
const { randomUUID } = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// -------------------------------------------------------------
// In-memory room store
// -------------------------------------------------------------
/**
 * rooms = {
 *   ABCDE: {
 *     code: "ABCDE",
 *     hostId: "player-uuid",
 *     createdAt: ms,
 *     gameStarted: false,
 *     players: [
 *       { id, name, animal, secretNumber, isBot, isAardvark, emoji }
 *     ],
 *     game: {
 *       aardvarkScore,
 *       chainCount,
 *       currentCaller,
 *       pendingSurvival,
 *       survivalDeadlineMs,
 *       survivalTimedOut,
 *       matchSecondsTotal,
 *       matchSecondsRemaining,
 *       matchEndTimeMs,
 *       history: [{ type, text, ts }]
 *     },
 *     streams: Set<res>
 *   }
 * }
 */
const rooms = Object.create(null);

// For simplicity, minimal emoji mapping
const DEFAULT_EMOJI = "🐾";

// Some animals for random use
const REAL_ANIMALS = [
  "Lion",
  "Tiger",
  "Elephant",
  "Giraffe",
  "Zebra",
  "Rhino",
  "Hippo",
  "Fox",
  "Wolf",
  "Kangaroo",
  "Panda",
  "Koala",
  "Monkey",
  "Eagle",
  "Bear",
  "Cheetah",
  "Leopard",
  "Buffalo",
  "Otter"
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
  "Magnet Gecko",
  "Shadow Squirrel",
  "Static Hedgehog",
  "Prism Raccoon",
  "Velvet Vulture",
  "Turbo Alpaca",
  "Frost Gecko",
  "Comet Ferret",
  "Echo Mantis",
  "Neon Badger",
  "Binary Otter",
  "Warp Turtle",
  "Volt Meerkat",
  "Aurora Fox",
  "Static Crocodile",
  "Quartz Hamster"
];

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------
function normalizeAnimalName(raw) {
  if (!raw) return "";
  const t = String(raw).trim();
  if (!t) return "";
  return t
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function randomRoomCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function isAnimalInGame(animal, room) {
  const norm = normalizeAnimalName(animal);
  if (!norm) return false;
  if (!room || !room.players) return false;
  return room.players.some((p) => p.animal === norm);
}

function isDecoyName(name) {
  return DECOYS.includes(name);
}

function broadcastToRoom(room) {
  if (!room || !room.streams) return;
  const payload = {
    type: "state",
    room: serializeRoom(room)
  };
  const str = "data: " + JSON.stringify(payload) + "\n\n";
  for (const res of room.streams) {
    res.write(str);
  }
}

function addRoomHistory(room, type, text) {
  if (!room.game) room.game = {};
  if (!room.game.history) room.game.history = [];
  room.game.history.push({
    type,
    text,
    ts: Date.now()
  });
  // keep last 200
  if (room.game.history.length > 200) {
    room.game.history.splice(0, room.game.history.length - 200);
  }
}

function serializeRoom(room) {
  // never send internal stream references
  return {
    code: room.code,
    hostId: room.hostId,
    createdAt: room.createdAt,
    gameStarted: room.gameStarted || false,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      animal: p.animal,
      secretNumber: p.secretNumber,
      isBot: p.isBot,
      isAardvark: p.isAardvark,
      emoji: p.emoji
    })),
    game: room.game
      ? {
          aardvarkScore: room.game.aardvarkScore || 0,
          chainCount: room.game.chainCount || 0,
          currentCaller: room.game.currentCaller || "Aardvark",
          pendingSurvival: room.game.pendingSurvival || null,
          survivalDeadlineMs: room.game.survivalDeadlineMs || null,
          survivalTimedOut: !!room.game.survivalTimedOut,
          matchSecondsRemaining: computeMatchSecondsRemaining(room),
          history: room.game.history || []
        }
      : null
  };
}

function computeMatchSecondsRemaining(room) {
  if (!room.game) return 0;
  const now = Date.now();
  if (room.game.matchEndTimeMs) {
    let remaining = Math.floor((room.game.matchEndTimeMs - now) / 1000);
    if (remaining < 0) remaining = 0;
    room.game.matchSecondsRemaining = remaining;
    return remaining;
  }
  return room.game.matchSecondsRemaining || 0;
}

function getSurvivalWindowSeconds(room) {
  const remaining = computeMatchSecondsRemaining(room);
  if (remaining <= 10) return 5;
  if (remaining <= 30) return 7;
  return 10;
}

function getCurrentAardvarkPlayer(room) {
  if (!room.players) return null;
  return room.players.find((p) => p.isAardvark);
}

function swapAardvarkWith(room, victimAnimalName) {
  const victimNorm = normalizeAnimalName(victimAnimalName);
  if (!victimNorm) return;

  const victim = room.players.find((p) => p.animal === victimNorm);
  const aard = getCurrentAardvarkPlayer(room);
  if (!victim || !aard) return;

  const victimAnimal = victim.animal;

  // Old Aardvark leaves middle, becomes that animal on the circle
  aard.animal = victimAnimal;

  // Victim moves to middle as new Aardvark, losing their old animal identity
  victim.animal = null;
  aard.isAardvark = false;
  victim.isAardvark = true;

  addRoomHistory(
    room,
    "info",
    `${victim.name} (${victimAnimal}) moves to the middle as Aardvark. ` +
      `${aard.name} becomes ${victimAnimal} on the circle.`
  );
}

// -------------------------------------------------------------
// API: Create room
// -------------------------------------------------------------
app.post("/api/rooms/create", (req, res) => {
  try {
    let code;
    do {
      code = randomRoomCode();
    } while (rooms[code]);

    const hostId = randomUUID();

    const hostPlayer = {
      id: hostId,
      name: "Host",
      animal:
        REAL_ANIMALS[Math.floor(Math.random() * REAL_ANIMALS.length)],
      secretNumber: null,
      isBot: false,
      isAardvark: false,
      emoji: DEFAULT_EMOJI
    };

    const room = {
      code,
      hostId,
      createdAt: Date.now(),
      players: [hostPlayer],
      gameStarted: false,
      game: null,
      streams: new Set()
    };

    rooms[code] = room;

    const responseRoom = serializeRoom(room);
    res.json({ ok: true, roomCode: code, playerId: hostId, room: responseRoom });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Internal error creating room" });
  }
});

// -------------------------------------------------------------
// API: Join room
// -------------------------------------------------------------
app.post("/api/rooms/join", (req, res) => {
  try {
    const { roomCode, name, animal, secretNumber, isBot } = req.body || {};
    if (!roomCode) {
      return res.status(400).json({ ok: false, error: "Missing roomCode" });
    }

    const room = rooms[roomCode];
    if (!room) {
      return res
        .status(404)
        .json({ ok: false, error: "Room not found" });
    }

    if (room.gameStarted) {
      return res
        .status(400)
        .json({ ok: false, error: "Game already started, room locked" });
    }

    const id = randomUUID();
    const player = {
      id,
      name: (name || "Player").toString().substring(0, 32),
      animal: normalizeAnimalName(animal || ""),
      secretNumber: secretNumber || null,
      isBot: !!isBot,
      isAardvark: false,
      emoji: DEFAULT_EMOJI
    };

    room.players.push(player);

    addRoomHistory(
      room,
      "info",
      `${player.name} joins the room with animal "${player.animal || "??"}".`
    );

    const responseRoom = serializeRoom(room);
    res.json({ ok: true, playerId: id, room: responseRoom });

    broadcastToRoom(room);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Internal error joining room" });
  }
});

// -------------------------------------------------------------
// API: Lock lobby & start game (choose Aardvark via dice closest to 15)
// -------------------------------------------------------------
app.post("/api/rooms/lock", (req, res) => {
  try {
    const { roomCode, playerId, matchMinutes } = req.body || {};
    if (!roomCode || !playerId) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing roomCode or playerId" });
    }

    const room = rooms[roomCode];
    if (!room) {
      return res.status(404).json({ ok: false, error: "Room not found" });
    }
    if (room.hostId !== playerId) {
      return res
        .status(403)
        .json({ ok: false, error: "Only host can lock lobby" });
    }
    if (!room.players || room.players.length < 2) {
      return res
        .status(400)
        .json({ ok: false, error: "Need at least 2 players to start" });
    }

    // Virtual dice: 2 dice per player, totals unique
    const usedTotals = new Set();
    room.players.forEach((p) => {
      let total, d1, d2, attempts = 0;
      do {
        d1 = 1 + Math.floor(Math.random() * 6);
        d2 = 1 + Math.floor(Math.random() * 6);
        total = d1 + d2;
        attempts++;
      } while (usedTotals.has(total) && attempts < 100);
      usedTotals.add(total);
      p.secretNumber = total;
      addRoomHistory(
        room,
        "info",
        `${p.name} (${p.animal || "??"}) rolls ${d1} + ${d2} = ${total} (distance ${Math.abs(
          total - 15
        )} from 15).`
      );
    });

    // Choose first Aardvark: closest to 15; tie => higher total
    let best = null;
    room.players.forEach((p) => {
      const total = p.secretNumber;
      const diff = Math.abs(total - 15);
      if (
        !best ||
        diff < best.diff ||
        (diff === best.diff && total > best.total)
      ) {
        best = { player: p, diff, total };
      }
    });

    room.players.forEach((p) => (p.isAardvark = false));

    if (best && best.player) {
      const first = best.player;
      const originalAnimal = first.animal;
      first.isAardvark = true;
      if (originalAnimal) {
        first.animal = null;
      }
      addRoomHistory(
        room,
        "info",
        `${first.name} is closest to 15 with a total of ${best.total} (distance ${best.diff}) and starts as Aardvark in the middle. ${
          originalAnimal
            ? `Their original animal "${originalAnimal}" is discarded from the circle.`
            : ""
        }`
      );
    } else {
      addRoomHistory(room, "info", "Aardvark starts in the middle by default.");
      const first = room.players[0];
      first.isAardvark = true;
      first.animal = null;
    }

    const minutes = Math.max(1, Math.min(30, matchMinutes || 5));
    const now = Date.now();

    room.gameStarted = true;
    room.game = {
      aardvarkScore: 0,
      chainCount: 0,
      currentCaller: "Aardvark",
      pendingSurvival: null,
      survivalDeadlineMs: null,
      survivalTimedOut: false,
      matchSecondsTotal: minutes * 60,
      matchSecondsRemaining: minutes * 60,
      matchEndTimeMs: now + minutes * 60 * 1000,
      history: room.game && room.game.history ? room.game.history : []
    };

    addRoomHistory(
      room,
      "info",
      `Match begins for ${minutes} minute(s). Aardvark calls first.`
    );

    const responseRoom = serializeRoom(room);
    res.json({ ok: true, room: responseRoom });
    broadcastToRoom(room);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Internal error locking lobby" });
  }
});

// -------------------------------------------------------------
// SSE stream for room
// -------------------------------------------------------------
app.get("/api/rooms/:code/stream", (req, res) => {
  const code = req.params.code;
  const room = rooms[code];
  if (!room) {
    res.status(404).end();
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  room.streams.add(res);

  // send initial snapshot
  const payload = { type: "state", room: serializeRoom(room) };
  res.write("data: " + JSON.stringify(payload) + "\n\n");

  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    res.write("data: " + JSON.stringify({ type: "heartbeat" }) + "\n\n");
  }, 30000);

  req.on("close", () => {
    clearInterval(heartbeat);
    room.streams.delete(res);
  });
});

// -------------------------------------------------------------
// API: Game action (online) - single endpoint for "call"
// NOTE: BONK in online mode is planned for later; currently calls only.
// -------------------------------------------------------------
app.post("/api/rooms/action", (req, res) => {
  try {
    const { roomCode, playerId, targetAnimal } = req.body || {};
    if (!roomCode || !playerId) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing roomCode or playerId" });
    }
    const room = rooms[roomCode];
    if (!room) {
      return res.status(404).json({ ok: false, error: "Room not found" });
    }
    if (!room.gameStarted || !room.game) {
      return res
        .status(400)
        .json({ ok: false, error: "Game not started in this room" });
    }

    const player = room.players.find((p) => p.id === playerId);
    if (!player) {
      return res.status(404).json({ ok: false, error: "Player not in room" });
    }

    // Always treat the action as coming from the currentCaller in this first implementation
    const callerName = room.game.currentCaller || "Aardvark";
    const normalizedTarget = normalizeAnimalName(targetAnimal || "");
    if (!normalizedTarget) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing targetAnimal" });
    }

    // Check match time
    const remaining = computeMatchSecondsRemaining(room);
    if (remaining <= 0) {
      addRoomHistory(room, "info", "Match already ended, no more calls.");
      const responseRoom = serializeRoom(room);
      return res.json({ ok: true, room: responseRoom });
    }

    const sentence = `${callerName} calls ${normalizedTarget}!`;
    const inGame = isAnimalInGame(normalizedTarget, room);
    const decoy = isDecoyName(normalizedTarget);

    // If current pendingSurvival timed out, just log & ignore calls (for now)
    if (room.game.pendingSurvival && room.game.survivalTimedOut) {
      addRoomHistory(
        room,
        "info",
        `Time already expired for ${room.game.pendingSurvival}. Pending BONK resolution. ` +
          "New calls are ignored until resolved (future BONK handling)."
      );
      const responseRoom = serializeRoom(room);
      res.json({ ok: true, room: responseRoom });
      broadcastToRoom(room);
      return;
    }

    // Wrong / decoy call
    if (!inGame || decoy) {
      addRoomHistory(
        room,
        "bad",
        sentence +
          " (not a real animal in this game or decoy). Chain snaps back toward Aardvark."
      );
      room.game.chainCount = 0;
      room.game.currentCaller = "Aardvark";

      // If caller was under survival, treat as automatic fail with potential auto-bonk
      if (
        room.game.pendingSurvival &&
        room.game.pendingSurvival === callerName
      ) {
        room.game.survivalTimedOut = true;
        addRoomHistory(
          room,
          "bad",
          `${callerName} used a decoy / wrong name under pressure. Server may auto-resolve with BONK in a future version.`
        );
      }

      const responseRoom = serializeRoom(room);
      res.json({ ok: true, room: responseRoom });
      broadcastToRoom(room);
      return;
    }

    // Valid in-game animal
    addRoomHistory(room, "neutral", sentence);

    // If caller was surviving Aardvark’s tag and succeeded in time:
    if (
      room.game.pendingSurvival &&
      room.game.pendingSurvival === callerName &&
      !room.game.survivalTimedOut
    ) {
      room.game.chainCount += 1;
      let penalty = 5;
      let msg = `${room.game.pendingSurvival} survives Aardvark and keeps the chain alive. −5 points for Aardvark.`;
      if (room.game.chainCount > 0 && room.game.chainCount % 3 === 0) {
        penalty += 5;
        msg += ` Streak bonus! Chain of ${room.game.chainCount} hits — extra −5 for Aardvark.`;
      }
      room.game.aardvarkScore = Math.max(
        0,
        room.game.aardvarkScore - penalty
      );
      addRoomHistory(room, "good", msg);
    }

    // The new animal is now under survival pressure
    const windowSec = getSurvivalWindowSeconds(room);
    room.game.pendingSurvival = normalizedTarget;
    room.game.survivalDeadlineMs = Date.now() + windowSec * 1000;
    room.game.survivalTimedOut = false;
    room.game.currentCaller = normalizedTarget;

    addRoomHistory(
      room,
      "info",
      `${normalizedTarget} is now up and has about ${windowSec} seconds to call a real animal or be bonked (future server BONK).`
    );

    const responseRoom = serializeRoom(room);
    res.json({ ok: true, room: responseRoom });
    broadcastToRoom(room);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Internal error in action" });
  }
});

// -------------------------------------------------------------
// Root route just for basic health-check
// -------------------------------------------------------------
app.get("/", (req, res) => {
  res.send("SURVIVE API is running.");
});

// -------------------------------------------------------------
// Start
// -------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`SURVIVE API listening on port ${PORT}`);
});
