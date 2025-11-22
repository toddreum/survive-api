// server.js
// Survive.com Aardvark arena backend

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// --------- ANIMALS / DECOYS ---------

const REAL_ANIMALS = [
  "Neon Lynx",
  "Shadow Mongoose",
  "Laser Otter",
  "Chaos Raccoon",
  "Voltage Wolf",
  "Pixel Panda",
  "Midnight Viper",
  "Turbo Falcon",
  "Rocket Badger",
  "Nova Shark",
  "Circuit Owl",
  "Phantom Fox",
  "Glacier Bear",
  "Storm Tiger",
  "Thunder Hippo",
  "Ghost Python",
  "Chrome Koala",
  "Ember Eagle"
];

// decoys are never assignable to players – just visual noise
const DECOY_ANIMALS = [
  "Abyss Kraken",
  "Void Unicorn",
  "Glitch Dragon",
  "Phantom Narwhal",
  "Hologram Phoenix",
  "Cyber Griffin",
  "Static Hedgehog",
  "Binary Sloth",
  "Quantum Penguin"
];

// --------- ROOM STATE ---------

/**
 * rooms: Map<roomCode, {
 *   code: string,
 *   hostId: string,
 *   createdAt: number,
 *   status: 'lobby' | 'running',
 *   aardvarkId: string | null,
 *   activeTargetId: string | null,
 *   players: Array<{
 *     socketId: string,
 *     name: string,
 *     animal: string | null,
 *     number: number | null,
 *     isAardvark: boolean,
 *     seatIndex: number | null,
 *     timesAardvark: number
 *   }>
 * }>
 */
const rooms = new Map();

// --------- HELPERS ---------

function makeRoomCode() {
  const letters = "ABCDEFGHJKMNPQRSTUVWXYZ";
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += letters[Math.floor(Math.random() * letters.length)];
  }
  return code;
}

function getRoom(roomCode) {
  return rooms.get(roomCode);
}

function getPlayer(room, socketId) {
  return room.players.find((p) => p.socketId === socketId);
}

function broadcastRoomState(room) {
  const payload = {
    roomCode: room.code,
    aardvarkId: room.aardvarkId,
    status: room.status,
    players: room.players.map((p) => ({
      socketId: p.socketId,
      name: p.name,
      animal: p.animal,
      number: p.number,
      isAardvark: p.isAardvark,
      seatIndex: p.seatIndex,
      timesAardvark: p.timesAardvark
    })),
    decoys: DECOY_ANIMALS
  };
  io.to(room.code).emit("roomStateUpdate", payload);
}

function getUniqueSeatIndex(room) {
  const used = new Set(room.players.map((p) => p.seatIndex));
  for (let i = 0; i < 20; i++) {
    if (!used.has(i)) return i;
  }
  return null;
}

function pickStartingAardvark(room) {
  // all players must have number + animal + unique
  const players = room.players;
  if (!players.length) return null;

  // require all numbers in 1..20 and unique
  const seenNums = new Set();
  for (const p of players) {
    if (typeof p.number !== "number") return null;
    if (p.number < 1 || p.number > 20) return null;
    if (seenNums.has(p.number)) return null;
    seenNums.add(p.number);
  }

  // require all animals non-empty + unique (case-insensitive)
  const seenAnimals = new Set();
  for (const p of players) {
    if (!p.animal) return null;
    const key = p.animal.trim().toLowerCase();
    if (seenAnimals.has(key)) return null;
    seenAnimals.add(key);
  }

  // closest to 20 wins starting Aardvark
  let best = null;
  for (const p of players) {
    const dist = Math.abs(20 - p.number);
    if (!best || dist < best.dist) {
      best = { id: p.socketId, dist };
    }
  }
  if (!best) return null;

  room.aardvarkId = best.id;

  for (const p of players) {
    p.isAardvark = p.socketId === best.id;
    if (p.isAardvark) {
      p.timesAardvark += 1;
      // starting Aardvark loses their animal alias (removed from ring)
      p.animal = null;
    }
  }

  return best.id;
}

function getRingPlayers(room) {
  return room.players.filter((p) => !p.isAardvark && p.animal);
}

function pickRandomRingTarget(room) {
  const ring = getRingPlayers(room);
  if (!ring.length) return null;
  const idx = Math.floor(Math.random() * ring.length);
  return ring[idx];
}

function swapAardvarkWithTarget(room) {
  if (!room.aardvarkId || !room.activeTargetId) return null;
  const aard = getPlayer(room, room.aardvarkId);
  const target = getPlayer(room, room.activeTargetId);
  if (!aard || !target) return null;
  if (aard.socketId === target.socketId) return null;

  // Aardvark becomes ring player and steals their animal + seat
  const tmpSeat = aard.seatIndex;
  const tmpAnimal = aard.animal;

  aard.isAardvark = false;
  aard.seatIndex = target.seatIndex;
  aard.animal = target.animal;

  // Target becomes new Aardvark in center, loses their animal identity
  target.isAardvark = true;
  target.seatIndex = tmpSeat; // often null or ignored visually for center
  target.animal = null;
  target.timesAardvark += 1;

  room.aardvarkId = target.socketId;
  const newAardvarkId = target.socketId;
  const oldAardvarkId = aard.socketId;

  // clear active target
  room.activeTargetId = null;

  return { newAardvarkId, oldAardvarkId, beatenId: target.socketId };
}

// --------- SOCKET.IO ---------

io.on("connection", (socket) => {
  console.log("Client connected", socket.id);

  socket.on("disconnect", () => {
    console.log("Client disconnected", socket.id);
    // remove from any room
    for (const room of rooms.values()) {
      const idx = room.players.findIndex((p) => p.socketId === socket.id);
      if (idx !== -1) {
        const wasHost = room.hostId === socket.id;
        room.players.splice(idx, 1);
        if (!room.players.length) {
          rooms.delete(room.code);
          break;
        } else {
          if (wasHost) {
            // promote first player as host
            room.hostId = room.players[0].socketId;
            io.to(room.code).emit("hostLeft", {
              message: "Host left. First player is the new host."
            });
          }
          // if Aardvark left, clear Aardvark
          if (room.aardvarkId === socket.id) {
            room.aardvarkId = null;
          }
          broadcastRoomState(room);
        }
      }
    }
  });

  // ---- Create Room ----
  socket.on("createRoom", ({ nickname }) => {
    const code = makeRoomCode();
    socket.join(code);

    const room = {
      code,
      hostId: socket.id,
      createdAt: Date.now(),
      status: "lobby",
      aardvarkId: null,
      activeTargetId: null,
      players: []
    };

    const player = {
      socketId: socket.id,
      name: nickname || "Host",
      animal: null,
      number: null,
      isAardvark: false,
      seatIndex: 0,
      timesAardvark: 0
    };

    room.players.push(player);
    rooms.set(code, room);

    socket.emit("roomCreated", { roomCode: code, isHost: true });
    broadcastRoomState(room);
  });

  // ---- Join Room ----
  socket.on("joinRoom", ({ roomCode, nickname }) => {
    const code = (roomCode || "").toUpperCase();
    const room = getRoom(code);

    if (!room) {
      socket.emit("joinError", { message: "Room not found." });
      return;
    }
    if (room.status !== "lobby") {
      socket.emit("joinError", { message: "Game already started." });
      return;
    }
    if (room.players.length >= 20) {
      socket.emit("joinError", { message: "Room is full." });
      return;
    }

    socket.join(code);

    const seatIndex = getUniqueSeatIndex(room);
    const player = {
      socketId: socket.id,
      name: nickname || "Player",
      animal: null,
      number: null,
      isAardvark: false,
      seatIndex,
      timesAardvark: 0
    };

    room.players.push(player);

    socket.emit("joinedRoom", { roomCode: code, isHost: room.hostId === socket.id });
    broadcastRoomState(room);
  });

  // ---- Choose Animal ----
  socket.on("chooseAnimal", ({ roomCode, animal }) => {
    const room = getRoom(roomCode);
    if (!room) return;

    const player = getPlayer(room, socket.id);
    if (!player) return;

    const name = (animal || "").trim();
    if (!name) {
      socket.emit("animalRejected", { reason: "Animal cannot be empty." });
      return;
    }

    // enforce unique, case-insensitive, and prevent using decoy names
    const key = name.toLowerCase();
    if (DECOY_ANIMALS.some((d) => d.toLowerCase() === key)) {
      socket.emit("animalRejected", {
        reason: "That animal is reserved as a decoy. Choose another."
      });
      return;
    }

    const conflict = room.players.some(
      (p) =>
        p.socketId !== socket.id &&
        p.animal &&
        p.animal.trim().toLowerCase() === key
    );
    if (conflict) {
      socket.emit("animalRejected", {
        reason: "That animal is already taken in this arena."
      });
      return;
    }

    player.animal = name;
    socket.emit("animalAccepted", { animal: name });
    broadcastRoomState(room);
  });

  // ---- Choose Number ----
  socket.on("chooseNumber", ({ roomCode, number }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    const player = getPlayer(room, socket.id);
    if (!player) return;

    const n = parseInt(number, 10);
    if (Number.isNaN(n) || n < 1 || n > 20) {
      socket.emit("numberRejected", {
        reason: "Number must be between 1 and 20."
      });
      return;
    }

    const conflict = room.players.some(
      (p) => p.socketId !== socket.id && p.number === n
    );
    if (conflict) {
      socket.emit("numberRejected", {
        reason: "That number is already taken in this arena."
      });
      return;
    }

    player.number = n;
    socket.emit("numberAccepted", { number: n });
    broadcastRoomState(room);
  });

  // ---- Lock Numbers + Pick Starting Aardvark ----
  socket.on("lockNumbersAndPickAardvark", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    if (room.hostId !== socket.id) return;

    const aardId = pickStartingAardvark(room);
    if (!aardId) {
      socket.emit("callError", {
        message:
          "All players need a unique animal + unique number 1–20 before locking."
      });
      return;
    }

    const aard = getPlayer(room, aardId);
    io.to(room.code).emit("aardvarkChosen", {
      aardvarkId: aardId,
      secretNumber: null, // kept for old client compatibility; unused
      aardvarkName: aard ? aard.name : null
    });

    broadcastRoomState(room);
  });

  // ---- Start Game ----
  socket.on("startGame", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    if (room.hostId !== socket.id) return;

    if (!room.aardvarkId) {
      socket.emit("callError", {
        message: "Pick a starting Aardvark first."
      });
      return;
    }

    room.status = "running";
    io.to(room.code).emit("gameStarted");
    broadcastRoomState(room);
  });

  // ---- Call Random Animal (host helper; Aardvark calls in real life) ----
  socket.on("callRandomAnimal", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    if (!room.aardvarkId) return;
    if (room.hostId !== socket.id) return;

    const target = pickRandomRingTarget(room);
    if (!target) {
      socket.emit("callError", { message: "No valid animals left to call." });
      return;
    }

    room.activeTargetId = target.socketId;

    io.to(room.code).emit("animalCalled", {
      animal: target.animal,
      playerName: target.name,
      socketId: target.socketId,
      windowMs: 10000
    });
  });

  // ---- Call Random Animal with Decoys (visual fun) ----
  socket.on("callAnimalWithDecoys", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    if (!room.aardvarkId) return;
    if (room.hostId !== socket.id) return;

    const target = pickRandomRingTarget(room);
    if (!target) {
      socket.emit("callError", { message: "No valid animals left to call." });
      return;
    }

    room.activeTargetId = target.socketId;

    // pick decoys from decoy pool
    const pool = [...DECOY_ANIMALS];
    const options = [target.animal];
    while (options.length < 3 && pool.length) {
      const idx = Math.floor(Math.random() * pool.length);
      options.push(pool.splice(idx, 1)[0]);
    }

    io.to(room.code).emit("animalCalledWithDecoys", {
      correctAnimal: target.animal,
      options,
      playerName: target.name,
      socketId: target.socketId,
      windowMs: 10000
    });
  });

  // ---- Aardvark Confirms Beat / Swap Seats ----
  socket.on("ramAttempt", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    if (!room.aardvarkId || room.aardvarkId !== socket.id) return;
    if (!room.activeTargetId) {
      socket.emit("callError", { message: "No active target to swap with." });
      return;
    }

    const result = swapAardvarkWithTarget(room);
    if (!result) {
      socket.emit("callError", {
        message: "Could not complete swap. Check room state."
      });
      return;
    }

    const { newAardvarkId, oldAardvarkId, beatenId } = result;

    io.to(room.code).emit("callResolved", {
      outcome: "swapped",
      aardvarkId: newAardvarkId,
      oldAardvarkId,
      beatenId
    });

    broadcastRoomState(room);
  });

  // ---- Escape Attempt (for backwards compatibility, just clears overlay) ----
  socket.on("escapeAttempt", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    // We don't auto-swap on escape; players enforce rules verbally.
    io.to(room.code).emit("callResolved", {
      outcome: "escaped",
      targetId: socket.id
    });
    room.activeTargetId = null;
    broadcastRoomState(room);
  });
});

// Simple health route
app.get("/", (req, res) => {
  res.send("Survive.com Aardvark API is running.");
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log("Survive API listening on port", PORT);
});
