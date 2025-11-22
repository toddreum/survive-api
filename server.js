// server.js
// Survive.com Aardvark Arena – Socket.IO backend

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_ORIGIN || "*",
    methods: ["GET", "POST"]
  }
});

// Simple health check
app.get("/", (req, res) => {
  res.json({ ok: true, service: "survive-api" });
});

/*
Room shape:

rooms: Map<roomCode, {
  roomCode: string;
  hostId: socketId;
  players: {
    socketId: string;
    name: string;
    animal: string | null;
    number: number | null;
    score: number;
    isBot: boolean;
  }[];
  aardvarkId: socketId | null;
  secretNumber: number | null;
  numbersLocked: boolean;
  gameStarted: boolean;
  calledAnimals: Set<string>;
  activeCall: {
    targetId: socketId;
    aardvarkId: socketId;
    expiresAt: number;
  } | null;
}>
*/

const rooms = new Map();

const decoyAnimals = [
  "aardvark",
  "unicorn",
  "dragon",
  "phoenix",
  "narwhal",
  "griffin",
  "platypus",
  "penguin",
  "sloth",
  "hedgehog",
  "yeti",
  "kraken"
];
const decoySetLower = new Set(decoyAnimals.map((a) => a.toLowerCase()));

// -------- Helpers --------

function generateRoomCode() {
  const letters = "ABCDEFGHJKMNPQRSTUVWXYZ"; // no I/O for clarity
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += letters[Math.floor(Math.random() * letters.length)];
  }
  return code;
}

function getRoom(roomCode) {
  if (!roomCode) return null;
  return rooms.get(roomCode);
}

function findPlayer(room, socketId) {
  if (!room) return null;
  return room.players.find((p) => p.socketId === socketId) || null;
}

function broadcastRoomState(room) {
  if (!room) return;
  const payload = {
    roomCode: room.roomCode,
    players: room.players,
    aardvarkId: room.aardvarkId,
    secretNumber: room.secretNumber
  };
  io.to(room.roomCode).emit("roomStateUpdate", payload);
}

function pickAardvark(room) {
  if (!room || !room.players.length) return;

  // Draw secret 1–20
  const secret = Math.floor(Math.random() * 20) + 1;
  room.secretNumber = secret;

  let best = null;
  room.players.forEach((p) => {
    if (typeof p.number !== "number") return;
    const dist = Math.abs(p.number - secret);
    if (!best || dist < best.dist) {
      best = { id: p.socketId, dist };
    }
  });

  room.aardvarkId = best ? best.id : null;
}

function ensureHost(socket, room) {
  return room && room.hostId === socket.id;
}

function getUncalledPlayersWithAnimals(room) {
  if (!room) return [];
  const called = room.calledAnimals || new Set();
  return room.players.filter(
    (p) =>
      p.animal &&
      !called.has(p.animal.toLowerCase())
  );
}

// -------- Socket.IO main --------

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // CREATE ROOM
  socket.on("createRoom", ({ nickname }) => {
    let code;
    do {
      code = generateRoomCode();
    } while (rooms.has(code));

    const room = {
      roomCode: code,
      hostId: socket.id,
      players: [
        {
          socketId: socket.id,
          name: nickname || "Host",
          animal: null,
          number: null,
          score: 0,
          isBot: false
        }
      ],
      aardvarkId: null,
      secretNumber: null,
      numbersLocked: false,
      gameStarted: false,
      calledAnimals: new Set(),
      activeCall: null
    };

    rooms.set(code, room);
    socket.join(code);

    socket.emit("roomCreated", { roomCode: code, isHost: true });
    broadcastRoomState(room);
  });

  // JOIN ROOM
  socket.on("joinRoom", ({ roomCode, nickname }) => {
    const code = (roomCode || "").toUpperCase();
    const room = getRoom(code);

    if (!room) {
      socket.emit("joinError", { message: "Room not found." });
      return;
    }

    let player = room.players.find((p) => p.socketId === socket.id);
    if (!player) {
      player = {
        socketId: socket.id,
        name: nickname || "Player",
        animal: null,
        number: null,
        score: 0,
        isBot: false
      };
      room.players.push(player);
      socket.join(code);
    }

    socket.emit("joinedRoom", {
      roomCode: code,
      isHost: room.hostId === socket.id
    });

    broadcastRoomState(room);
  });

  // CHOOSE ANIMAL
  socket.on("chooseAnimal", ({ roomCode, animal }) => {
    const room = getRoom(roomCode);
    if (!room) return;

    const player = findPlayer(room, socket.id);
    if (!player) return;

    const name = (animal || "").trim();
    if (!name) {
      socket.emit("animalRejected", { reason: "Animal cannot be empty." });
      return;
    }

    const lower = name.toLowerCase();
    if (decoySetLower.has(lower)) {
      socket.emit("animalRejected", {
        reason: "That animal is reserved as a decoy."
      });
      return;
    }

    const conflict = room.players.find(
      (p) =>
        p.socketId !== socket.id &&
        p.animal &&
        p.animal.toLowerCase() === lower
    );
    if (conflict) {
      socket.emit("animalRejected", {
        reason: "That animal is already taken."
      });
      return;
    }

    player.animal = name;
    socket.emit("animalAccepted", { animal: name });
    broadcastRoomState(room);
  });

  // CHOOSE NUMBER
  socket.on("chooseNumber", ({ roomCode, number }) => {
    const room = getRoom(roomCode);
    if (!room) return;

    const player = findPlayer(room, socket.id);
    if (!player) return;

    const num = parseInt(number, 10);
    if (!Number.isFinite(num) || num < 1 || num > 20) {
      socket.emit("numberRejected", {
        reason: "Number must be between 1 and 20."
      });
      return;
    }

    const conflict = room.players.find(
      (p) => p.socketId !== socket.id && p.number === num
    );
    if (conflict) {
      socket.emit("numberRejected", {
        reason: "That number is already taken."
      });
      return;
    }

    player.number = num;
    socket.emit("numberAccepted", { number: num });
    broadcastRoomState(room);
  });

  // LOCK NUMBERS + PICK AARDVARK
  socket.on("lockNumbersAndPickAardvark", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room || !ensureHost(socket, room)) return;

    if (room.players.some((p) => typeof p.number !== "number")) {
      socket.emit("callError", {
        message: "Everyone needs a number before locking."
      });
      return;
    }

    pickAardvark(room);
    room.numbersLocked = true;
    room.calledAnimals = new Set();
    room.activeCall = null;

    io.to(roomCode).emit("numbersLocked", {
      secretNumber: room.secretNumber
    });

    io.to(roomCode).emit("aardvarkChosen", {
      aardvarkId: room.aardvarkId,
      secretNumber: room.secretNumber
    });

    broadcastRoomState(room);
  });

  // START GAME
  socket.on("startGame", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room || !ensureHost(socket, room)) return;

    if (!room.numbersLocked || !room.aardvarkId) {
      socket.emit("callError", {
        message: "Lock numbers and pick the Aardvark first."
      });
      return;
    }

    room.gameStarted = true;
    room.calledAnimals = new Set();
    room.activeCall = null;

    io.to(roomCode).emit("gameStarted");
    broadcastRoomState(room);
  });

  // CALL RANDOM ANIMAL (no decoys)
  socket.on("callRandomAnimal", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room || !ensureHost(socket, room)) return;

    if (!room.gameStarted) {
      socket.emit("callError", {
        message: "Start the game before calling animals."
      });
      return;
    }

    const uncalled = getUncalledPlayersWithAnimals(room);
    if (!uncalled.length) {
      socket.emit("callError", {
        message: "All animals have been called this round."
      });
      return;
    }

    const chosen =
      uncalled[Math.floor(Math.random() * uncalled.length)];
    room.calledAnimals.add(chosen.animal.toLowerCase());

    const windowMs = 10000;
    room.activeCall = {
      targetId: chosen.socketId,
      aardvarkId: room.aardvarkId,
      expiresAt: Date.now() + windowMs
    };

    io.to(roomCode).emit("animalCalled", {
      animal: chosen.animal,
      playerName: chosen.name,
      socketId: chosen.socketId,
      windowMs
    });
  });

  // CALL ANIMAL WITH DECOYS
  socket.on("callAnimalWithDecoys", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room || !ensureHost(socket, room)) return;

    if (!room.gameStarted) {
      socket.emit("callError", {
        message: "Start the game before calling animals."
      });
      return;
    }

    const uncalled = getUncalledPlayersWithAnimals(room);
    if (!uncalled.length) {
      socket.emit("callError", {
        message: "All animals have been called this round."
      });
      return;
    }

    const chosen =
      uncalled[Math.floor(Math.random() * uncalled.length)];
    room.calledAnimals.add(chosen.animal.toLowerCase());

    const playerAnimalSet = new Set(
      room.players
        .filter((p) => p.animal)
        .map((p) => p.animal.toLowerCase())
    );

    const validDecoys = decoyAnimals.filter(
      (d) =>
        d.toLowerCase() !== chosen.animal.toLowerCase() &&
        !playerAnimalSet.has(d.toLowerCase())
    );

    const shuffled = validDecoys.sort(() => Math.random() - 0.5);
    const chosenDecoys = shuffled.slice(0, 2);
    const options = [chosen.animal, ...chosenDecoys].sort(
      () => Math.random() - 0.5
    );

    const windowMs = 10000;
    room.activeCall = {
      targetId: chosen.socketId,
      aardvarkId: room.aardvarkId,
      expiresAt: Date.now() + windowMs
    };

    io.to(roomCode).emit("animalCalledWithDecoys", {
      correctAnimal: chosen.animal,
      options,
      playerName: chosen.name,
      socketId: chosen.socketId,
      windowMs
    });
  });

  // RAM ATTEMPT (Aardvark)
  socket.on("ramAttempt", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room || !room.activeCall) return;

    const call = room.activeCall;
    const now = Date.now();
    if (now > call.expiresAt) return;

    if (socket.id !== call.aardvarkId) return;

    const target = room.players.find(
      (p) => p.socketId === call.targetId
    );
    const aard = room.players.find(
      (p) => p.socketId === call.aardvarkId
    );
    if (!target || !aard) return;

    aard.score = (aard.score || 0) + 5;
    target.score = (target.score || 0) - 3;

    io.to(roomCode).emit("callResolved", {
      outcome: "rammed",
      targetId: target.socketId,
      scores: room.players
    });

    room.activeCall = null;
    broadcastRoomState(room);
  });

  // ESCAPE ATTEMPT (target player)
  socket.on("escapeAttempt", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room || !room.activeCall) return;

    const call = room.activeCall;
    const now = Date.now();
    if (now > call.expiresAt) return;

    if (socket.id !== call.targetId) return;

    const target = room.players.find(
      (p) => p.socketId === call.targetId
    );
    const aard = room.players.find(
      (p) => p.socketId === call.aardvarkId
    );
    if (!target || !aard) return;

    target.score = (target.score || 0) + 3;
    aard.score = (aard.score || 0) - 2;

    io.to(roomCode).emit("callResolved", {
      outcome: "escaped",
      targetId: target.socketId,
      scores: room.players
    });

    room.activeCall = null;
    broadcastRoomState(room);
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);

    for (const [code, room] of rooms.entries()) {
      const idx = room.players.findIndex(
        (p) => p.socketId === socket.id
      );
      if (idx === -1) continue;

      const wasHost = room.hostId === socket.id;
      room.players.splice(idx, 1);

      if (!room.players.length || wasHost) {
        io.to(code).emit("hostLeft", {
          message: "Host left. Room closed."
        });
        rooms.delete(code);
      } else {
        if (room.aardvarkId === socket.id) {
          room.aardvarkId = null;
          room.secretNumber = null;
          room.numbersLocked = false;
          room.gameStarted = false;
          room.activeCall = null;
          room.calledAnimals = new Set();
        }
        broadcastRoomState(room);
      }
    }
  });
});

// -------- Start server --------

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🦡 Survive API listening on http://localhost:${PORT}`);
});
