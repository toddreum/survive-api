const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);

// CORS open so front end can be anywhere (cpanel, Netlify, etc.)
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Serve static frontend
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// -------- IN-MEMORY GAME STATE --------
//
// rooms[roomCode] = {
//   code,
//   hostId,
//   players: { socketId: { name, animal, number, score, joinedAt } },
//   calledAnimals: Set<string>,
//   state: "lobby" | "numbers" | "arena",
//   aardvarkId: string | null,
//   secretNumber: number | null,
//   currentCall: { targetId, startedAt, resolved } | null
// }

const rooms = {};

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

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  if (rooms[code]) return generateRoomCode();
  return code;
}

function getRoomPlayers(roomCode) {
  const room = rooms[roomCode];
  if (!room) return [];
  return Object.entries(room.players).map(([sid, p]) => ({
    socketId: sid,
    name: p.name,
    animal: p.animal,
    number: p.number,
    score: p.score ?? 0
  }));
}

function broadcastRoomState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const players = getRoomPlayers(roomCode);
  io.to(roomCode).emit("roomStateUpdate", {
    roomCode,
    players,
    calledAnimals: Array.from(room.calledAnimals),
    state: room.state,
    aardvarkId: room.aardvarkId,
    secretNumber: room.secretNumber
  });
}

// -------- SOCKET.IO GAME LOGIC --------

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // CREATE ROOM (host)
  socket.on("createRoom", ({ nickname }) => {
    const roomCode = generateRoomCode();

    rooms[roomCode] = {
      code: roomCode,
      hostId: socket.id,
      players: {},
      calledAnimals: new Set(),
      state: "lobby",
      aardvarkId: null,
      secretNumber: null,
      currentCall: null
    };

    rooms[roomCode].players[socket.id] = {
      name: nickname || "Host",
      animal: null,
      number: null,
      score: 0,
      joinedAt: Date.now()
    };

    socket.join(roomCode);
    socket.emit("roomCreated", { roomCode, isHost: true });
    broadcastRoomState(roomCode);
  });

  // JOIN ROOM
  socket.on("joinRoom", ({ roomCode, nickname }) => {
    roomCode = (roomCode || "").toUpperCase();
    const room = rooms[roomCode];
    if (!room) {
      socket.emit("joinError", { message: "Room not found." });
      return;
    }

    rooms[roomCode].players[socket.id] = {
      name: nickname || "Player",
      animal: null,
      number: null,
      score: 0,
      joinedAt: Date.now()
    };

    socket.join(roomCode);
    socket.emit("joinedRoom", {
      roomCode,
isHost: room.hostId === socket.id
    });
    broadcastRoomState(roomCode);
  });

  // CHOOSE ANIMAL
  socket.on("chooseAnimal", ({ roomCode, animal }) => {
    roomCode = (roomCode || "").toUpperCase();
    animal = (animal || "").trim();
    const room = rooms[roomCode];

    if (!room) {
      socket.emit("animalRejected", { reason: "Room not found." });
      return;
    }
    if (!animal) {
      socket.emit("animalRejected", { reason: "Animal name cannot be empty." });
      return;
    }

    const lower = animal.toLowerCase();

    if (decoySetLower.has(lower)) {
      socket.emit("animalRejected", {
        reason: "That animal is reserved as a decoy. Choose another!"
      });
      return;
    }

    for (const [sid, p] of Object.entries(room.players)) {
      if (sid === socket.id) continue;
      if (p.animal && p.animal.toLowerCase() === lower) {
        socket.emit("animalRejected", {
          reason: "That animal is already taken by another player."
        });
        return;
      }
    }

    room.players[socket.id].animal = animal;
    socket.emit("animalAccepted", { animal });
    broadcastRoomState(roomCode);
  });

  // CHOOSE NUMBER 1–20
  socket.on("chooseNumber", ({ roomCode, number }) => {
    roomCode = (roomCode || "").toUpperCase();
    const room = rooms[roomCode];
    if (!room) {
      socket.emit("numberRejected", { reason: "Room not found." });
      return;
    }
    if (typeof number !== "number" || number < 1 || number > 20) {
      socket.emit("numberRejected", {
        reason: "Number must be between 1 and 20."
      });
      return;
    }

    for (const [sid, p] of Object.entries(room.players)) {
      if (sid === socket.id) continue;
      if (p.number === number) {
        socket.emit("numberRejected", {
          reason: "That number is already taken by another player."
        });
        return;
      }
    }

    room.players[socket.id].number = number;
    socket.emit("numberAccepted", { number });
    broadcastRoomState(roomCode);
  });

  // HOST LOCKS NUMBERS & PICKS AARDVARK
  socket.on("lockNumbersAndPickAardvark", ({ roomCode }) => {
    roomCode = (roomCode || "").toUpperCase();
    const room = rooms[roomCode];
    if (!room) return;
    if (room.hostId !== socket.id) return;

    const players = getRoomPlayers(roomCode);
    if (!players.length) return;

    if (players.some((p) => p.number == null)) {
      socket.emit("numbersLockError", {
        message: "All players must choose a number first."
      });
      return;
    }

    const secret = Math.floor(Math.random() * 20) + 1;
    let best = null;
    players.forEach((p) => {
      const dist = Math.abs(p.number - secret);
      if (!best || dist < best.dist) {
        best = { id: p.socketId, dist };
      }
    });

    room.secretNumber = secret;
    room.aardvarkId = best ? best.id : null;
    room.state = "arena";
    room.currentCall = null;

    io.to(roomCode).emit("numbersLocked", { secretNumber: secret });
    io.to(roomCode).emit("aardvarkChosen", {
      aardvarkId: room.aardvarkId,
      secretNumber: secret
    });
    broadcastRoomState(roomCode);
  });

  // START GAME (host)
  socket.on("startGame", ({ roomCode }) => {
    roomCode = (roomCode || "").toUpperCase();
    const room = rooms[roomCode];
    if (!room) return;
    if (room.hostId !== socket.id) return;

    room.state = "arena";
    room.calledAnimals = new Set();
    room.currentCall = null;
    io.to(roomCode).emit("gameStarted", { roomCode });
    broadcastRoomState(roomCode);
  });

  // CALL RANDOM ANIMAL
  socket.on("callRandomAnimal", ({ roomCode }) => {
    roomCode = (roomCode || "").toUpperCase();
    const room = rooms[roomCode];
    if (!room) return;
    if (room.hostId !== socket.id) return;

    const players = getRoomPlayers(roomCode).filter((p) => p.animal);
    const uncalled = players.filter(
      (p) => !room.calledAnimals.has(p.animal.toLowerCase())
    );

    if (!uncalled.length) {
      socket.emit("callError", { message: "All animals have been called!" });
      return;
    }

    const chosen = uncalled[Math.floor(Math.random() * uncalled.length)];
    room.calledAnimals.add(chosen.animal.toLowerCase());
    room.currentCall = {
      targetId: chosen.socketId,
      startedAt: Date.now(),
      resolved: false
    };

    io.to(roomCode).emit("animalCalled", {
      animal: chosen.animal,
      playerName: chosen.name,
      socketId: chosen.socketId,
      windowMs: 10000
    });

    broadcastRoomState(roomCode);
  });

  // CALL WITH DECOYS
  socket.on("callAnimalWithDecoys", ({ roomCode }) => {
    roomCode = (roomCode || "").toUpperCase();
    const room = rooms[roomCode];
    if (!room) return;
    if (room.hostId !== socket.id) return;

    const players = getRoomPlayers(roomCode).filter((p) => p.animal);
    const uncalled = players.filter(
      (p) => !room.calledAnimals.has(p.animal.toLowerCase())
    );

    if (!uncalled.length) {
      socket.emit("callError", { message: "All animals have been called!" });
      return;
    }

    const chosen = uncalled[Math.floor(Math.random() * uncalled.length)];
    room.calledAnimals.add(chosen.animal.toLowerCase());

    const playerAnimalSet = new Set(
      players.map((p) => (p.animal || "").toLowerCase())
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

    room.currentCall = {
      targetId: chosen.socketId,
      startedAt: Date.now(),
      resolved: false
    };

    io.to(roomCode).emit("animalCalledWithDecoys", {
      correctAnimal: chosen.animal,
      options,
      playerName: chosen.name,
      socketId: chosen.socketId,
      windowMs: 10000
    });

    broadcastRoomState(roomCode);
  });

  // ESCAPE ATTEMPT
  socket.on("escapeAttempt", ({ roomCode }) => {
    roomCode = (roomCode || "").toUpperCase();
    const room = rooms[roomCode];
    if (!room || !room.currentCall) return;
    const call = room.currentCall;

    if (call.resolved) return;
    if (socket.id !== call.targetId) return;

    const now = Date.now();
    if (now - call.startedAt > 11000) {
      return;
    }

    call.resolved = true;

    const aard = room.players[room.aardvarkId];
    const target = room.players[call.targetId];
    if (aard && target) {
      target.score = (target.score ?? 0) + 3;
      aard.score = (aard.score ?? 0) - 2;
    }

    io.to(roomCode).emit("callResolved", {
      outcome: "escaped",
      targetId: call.targetId,
      aardvarkId: room.aardvarkId,
      scores: getRoomPlayers(roomCode)
    });

    broadcastRoomState(roomCode);
  });

  // RAM ATTEMPT (Aardvark only)
  socket.on("ramAttempt", ({ roomCode }) => {
    roomCode = (roomCode || "").toUpperCase();
    const room = rooms[roomCode];
    if (!room || !room.currentCall) return;
    const call = room.currentCall;

    if (call.resolved) return;
    if (socket.id !== room.aardvarkId) return;

    const now = Date.now();
    if (now - call.startedAt > 11000) {
      return;
    }

    call.resolved = true;

    const aard = room.players[room.aardvarkId];
    const target = room.players[call.targetId];
    if (aard && target) {
      aard.score = (aard.score ?? 0) + 5;
      target.score = (target.score ?? 0) - 3;
    }

    io.to(roomCode).emit("callResolved", {
      outcome: "rammed",
      targetId: call.targetId,
      aardvarkId: room.aardvarkId,
      scores: getRoomPlayers(roomCode)
    });

    broadcastRoomState(roomCode);
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);

    for (const [code, room] of Object.entries(rooms)) {
      if (room.players[socket.id]) {
        delete room.players[socket.id];

        if (room.hostId === socket.id) {
          io.to(code).emit("hostLeft", {
            message: "Host left. Room is closing."
          });
          io.in(code).socketsLeave(code);
          delete rooms[code];
        } else {
          broadcastRoomState(code);
        }
        break;
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Survive.com arena server running on port ${PORT}`);
});
