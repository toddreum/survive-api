// server.js
// Socket.IO backend for Survive.com Aardvark arena

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const PORT = process.env.PORT || 3000;

// ------------ EXPRESS / HTTP ------------
const app = express();

// Adjust origins to match where your front-end is hosted
const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:4173",
  "http://localhost:5173",
  "https://survive.com",
  "https://www.survive.com"
];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(null, true); // loosen if using multiple dev URLs
    }
  })
);

app.get("/", (req, res) => {
  res.send("Survive.com Aardvark Arena API is running.");
});

const server = http.createServer(app);

// ------------ SOCKET.IO ------------
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"]
  }
});

// ------------ GAME STATE ------------

/**
 * rooms: {
 *   [roomCode]: {
 *     code,
 *     hostId,
 *     status: "lobby" | "locked" | "running",
 *     players: [
 *       {
 *         socketId,
 *         name,
 *         animal,
 *         number,      // 1–20
 *         isAardvark,
 *         points,      // scoring
 *         timesAardvark
 *       }, ...
 *     ],
 *     decoys: string[],
 *     lastCall: {
 *       targetSocketId,
 *       aardvarkId,
 *       expiresAt
 *     } | null
 *   }
 * }
 */
const rooms = new Map();

// decoy animals to mix in online as well
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
const decoyLower = new Set(DECOY_ANIMALS.map((a) => a.toLowerCase()));

// helpers
function generateRoomCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ"; // no I/O
  let code;
  do {
    code = Array.from({ length: 4 })
      .map(() => alphabet[Math.floor(Math.random() * alphabet.length)])
      .join("");
  } while (rooms.has(code));
  return code;
}

function getRoom(roomCode) {
  if (!roomCode) return null;
  return rooms.get(roomCode.toUpperCase()) || null;
}

function sanitizePlayers(players = []) {
  return players.map((p) => ({
    socketId: p.socketId,
    name: p.name,
    animal: p.animal,
    number: p.number,
    isAardvark: p.isAardvark,
    points: p.points || 0,
    timesAardvark: p.timesAardvark || 0
  }));
}

function emitRoomState(room) {
  const payload = {
    roomCode: room.code,
    players: sanitizePlayers(room.players),
    aardvarkId: room.players.find((p) => p.isAardvark)?.socketId || null,
    status: room.status,
    decoys: room.decoys
  };
  io.to(room.code).emit("roomStateUpdate", payload);
}

function findPlayer(room, socketId) {
  return room.players.find((p) => p.socketId === socketId) || null;
}

function allNumbersUnique(room) {
  const used = new Set();
  for (const p of room.players) {
    if (p.number == null) return false;
    if (used.has(p.number)) return false;
    used.add(p.number);
  }
  return true;
}

// ------------ SOCKET LOGIC ------------

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("Socket disconnected:", socket.id);
    // remove from rooms, handle host leaving
    for (const [code, room] of rooms) {
      const idx = room.players.findIndex((p) => p.socketId === socket.id);
      if (idx !== -1) {
        const leaving = room.players[idx];
        room.players.splice(idx, 1);

        // if host leaves -> close room
        if (room.hostId === socket.id) {
          io.to(code).emit("hostLeft", {
            message: "Host left. Room closed."
          });
          rooms.delete(code);
          console.log("Room closed (host left):", code);
          break;
        } else {
          emitRoomState(room);
        }
      }
    }
  });

  // -------- createRoom --------
  socket.on("createRoom", ({ nickname }) => {
    const name = (nickname || "Host").toString().trim().slice(0, 32) || "Host";
    const roomCode = generateRoomCode();

    const hostPlayer = {
      socketId: socket.id,
      name,
      animal: null,
      number: null,
      isAardvark: false,
      points: 0,
      timesAardvark: 0
    };

    const room = {
      code: roomCode,
      hostId: socket.id,
      status: "lobby",
      players: [hostPlayer],
      decoys: [...DECOY_ANIMALS],
      lastCall: null
    };

    rooms.set(roomCode, room);
    socket.join(roomCode);

    socket.emit("roomCreated", { roomCode, isHost: true });
    emitRoomState(room);

    console.log(`Room created: ${roomCode} by ${socket.id}`);
  });

  // -------- joinRoom --------
  socket.on("joinRoom", ({ roomCode, nickname }) => {
    const code = (roomCode || "").toString().trim().toUpperCase();
    const room = getRoom(code);
    if (!room) {
      socket.emit("joinError", { message: "Room not found." });
      return;
    }

    if (room.players.length >= 20) {
      socket.emit("joinError", { message: "Room is full." });
      return;
    }

    const name =
      (nickname || "Player").toString().trim().slice(0, 32) || "Player";

    // no duplicate names
    if (
      room.players.some(
        (p) => p.name.toLowerCase() === name.toLowerCase()
      )
    ) {
      socket.emit("joinError", { message: "Name already taken in this room." });
      return;
    }

    const newPlayer = {
      socketId: socket.id,
      name,
      animal: null,
      number: null,
      isAardvark: false,
      points: 0,
      timesAardvark: 0
    };
    room.players.push(newPlayer);

    socket.join(code);
    socket.emit("joinedRoom", { roomCode: code, isHost: false });
    emitRoomState(room);

    console.log(`Socket ${socket.id} joined room ${code}`);
  });

  // -------- chooseAnimal --------
  socket.on("chooseAnimal", ({ roomCode, animal }) => {
    const room = getRoom(roomCode);
    if (!room) return;

    const player = findPlayer(room, socket.id);
    if (!player) return;

    const raw = (animal || "").toString().trim();
    if (!raw) {
      socket.emit("animalRejected", { reason: "Animal cannot be empty." });
      return;
    }

    const lower = raw.toLowerCase();

    // can't be a decoy
    if (decoyLower.has(lower)) {
      socket.emit("animalRejected", {
        reason: "That name is reserved as a decoy. Choose another."
      });
      return;
    }

    // must be unique in room
    if (
      room.players.some(
        (p) => p.socketId !== socket.id && p.animal && p.animal.toLowerCase() === lower
      )
    ) {
      socket.emit("animalRejected", {
        reason: "That animal is already taken by someone else."
      });
      return;
    }

    player.animal = raw;
    socket.emit("animalAccepted", { animal: raw });
    emitRoomState(room);
  });

  // -------- chooseNumber --------
  socket.on("chooseNumber", ({ roomCode, number }) => {
    const room = getRoom(roomCode);
    if (!room) return;

    const player = findPlayer(room, socket.id);
    if (!player) return;

    const n = parseInt(number, 10);
    if (!Number.isInteger(n) || n < 1 || n > 20) {
      socket.emit("numberRejected", {
        reason: "Number must be between 1 and 20."
      });
      return;
    }

    // unique in room
    if (
      room.players.some(
        (p) => p.socketId !== socket.id && p.number === n
      )
    ) {
      socket.emit("numberRejected", {
        reason: "That number is already taken by another player."
      });
      return;
    }

    player.number = n;
    socket.emit("numberAccepted", { number: n });
    emitRoomState(room);
  });

  // -------- lockNumbersAndPickAardvark --------
  socket.on("lockNumbersAndPickAardvark", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    if (room.hostId !== socket.id) return;

    if (!room.players.length) return;

    if (!allNumbersUnique(room)) {
      socket.emit("callError", {
        message:
          "Everyone needs a unique number 1–20 before you can lock and pick the Aardvark."
      });
      return;
    }

    // pick player whose number is closest to 20
    let best = null;
    room.players.forEach((p) => {
      const dist = Math.abs(20 - p.number);
      if (!best || dist < best.dist) {
        best = { player: p, dist };
      }
    });

    if (!best) return;

    // reset and assign Aardvark
    room.players.forEach((p) => (p.isAardvark = false));
    const aard = best.player;
    aard.isAardvark = true;
    aard.timesAardvark = (aard.timesAardvark || 0) + 1;
    aard.animal = null; // loses alias when in center

    room.status = "locked";
    room.lastCall = null;

    io.to(room.code).emit("aardvarkChosen", {
      aardvarkId: aard.socketId,
      aardvarkName: aard.name
    });
    emitRoomState(room);

    console.log("Aardvark chosen in room", room.code, "->", aard.name);
  });

  // -------- startGame --------
  socket.on("startGame", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    if (room.hostId !== socket.id) return;

    room.status = "running";
    room.lastCall = null;
    io.to(room.code).emit("gameStarted");
    emitRoomState(room);

    console.log("Game started in room", room.code);
  });

  // -------- callRandomAnimal --------
  socket.on("callRandomAnimal", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    if (room.hostId !== socket.id) return;
    if (room.status !== "running") {
      socket.emit("callError", { message: "Game not running yet." });
      return;
    }

    const aard = room.players.find((p) => p.isAardvark);
    if (!aard) {
      socket.emit("callError", { message: "No Aardvark chosen yet." });
      return;
    }

    // valid ring players: have animal + not Aardvark
    const ring = room.players.filter((p) => !p.isAardvark && p.animal);
    if (!ring.length) {
      socket.emit("callError", { message: "No valid animals left to call." });
      return;
    }

    const target =
      ring[Math.floor(Math.random() * ring.length)];

    const windowMs = 10000;
    const now = Date.now();

    room.lastCall = {
      targetSocketId: target.socketId,
      aardvarkId: aard.socketId,
      expiresAt: now + windowMs
    };

    io.to(room.code).emit("animalCalled", {
      animal: target.animal,
      playerName: target.name,
      socketId: target.socketId,
      windowMs
    });
  });

  // -------- callAnimalWithDecoys --------
  socket.on("callAnimalWithDecoys", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    if (room.hostId !== socket.id) return;
    if (room.status !== "running") {
      socket.emit("callError", { message: "Game not running yet." });
      return;
    }

    const aard = room.players.find((p) => p.isAardvark);
    if (!aard) {
      socket.emit("callError", { message: "No Aardvark chosen yet." });
      return;
    }

    const ring = room.players.filter((p) => !p.isAardvark && p.animal);
    if (!ring.length) {
      socket.emit("callError", { message: "No valid animals left to call." });
      return;
    }

    const target =
      ring[Math.floor(Math.random() * ring.length)];

    // pick 2 decoys that are not actual animals
    const realSet = new Set(
      ring.map((p) => (p.animal || "").toLowerCase())
    );
    const validDecoys = DECOY_ANIMALS.filter(
      (d) => !realSet.has(d.toLowerCase())
    );
    const shuffled = [...validDecoys].sort(() => Math.random() - 0.5);
    const chosenDecoys = shuffled.slice(0, 2);

    const options = [target.animal, ...chosenDecoys].sort(
      () => Math.random() - 0.5
    );

    const windowMs = 10000;
    const now = Date.now();

    room.lastCall = {
      targetSocketId: target.socketId,
      aardvarkId: aard.socketId,
      expiresAt: now + windowMs
    };

    io.to(room.code).emit("animalCalledWithDecoys", {
      correctAnimal: target.animal,
      options,
      playerName: target.name,
      socketId: target.socketId,
      windowMs
    });
  });

  // -------- ramAttempt (Aardvark claims they beat target) --------
  socket.on("ramAttempt", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;

    const lc = room.lastCall;
    if (!lc) return;
    if (lc.aardvarkId !== socket.id) {
      // only the current Aardvark should confirm swap
      return;
    }

    const now = Date.now();
    if (now > lc.expiresAt) {
      room.lastCall = null;
      io.to(room.code).emit("callResolved", { outcome: "timeout" });
      emitRoomState(room);
      return;
    }

    const target = room.players.find(
      (p) => p.socketId === lc.targetSocketId
    );
    const aard = room.players.find(
      (p) => p.socketId === lc.aardvarkId
    );
    if (!target || !aard) {
      room.lastCall = null;
      io.to(room.code).emit("callResolved", { outcome: "invalid" });
      emitRoomState(room);
      return;
    }

    // scoring: called player loses 5 points
    target.points = (target.points || 0) - 5;

    // swap roles: Aardvark steals name, target becomes new Aardvark
    const stolenAnimal = target.animal;
    aard.isAardvark = false;
    aard.animal = stolenAnimal;

    target.isAardvark = true;
    target.animal = null;
    target.timesAardvark = (target.timesAardvark || 0) + 1;

    room.lastCall = null;

    io.to(room.code).emit("callResolved", {
      outcome: "swapped"
    });
    emitRoomState(room);
  });

  // -------- escapeAttempt (table rules: Aardvark failed) --------
  socket.on("escapeAttempt", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;

    const lc = room.lastCall;
    if (!lc) {
      io.to(room.code).emit("callResolved", { outcome: "escaped" });
      emitRoomState(room);
      return;
    }

    const aard = room.players.find(
      (p) => p.socketId === lc.aardvarkId
    );
    if (aard) {
      // Aardvark loses 2 points for a failed or fake call
      aard.points = (aard.points || 0) - 2;
    }

    room.lastCall = null;
    io.to(room.code).emit("callResolved", { outcome: "escaped" });
    emitRoomState(room);
  });
});

// ------------ START SERVER ------------
server.listen(PORT, () => {
  console.log(`Survive.com arena server running on port ${PORT}`);
});
