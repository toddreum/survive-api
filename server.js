const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// Room state: roomCode -> room object
const rooms = {};

function createRoomIfNeeded(roomCode) {
  if (!rooms[roomCode]) {
    rooms[roomCode] = {
      players: {}, // socketId -> { name, animal, score }
      hostId: null,
      middleId: null,
      phase: "lobby", // "lobby" | "guessing" | "playing"
      secretNumber: null, // 1–20
      guesses: {}, // socketId -> number
      duel: null // { middleId, targetId, status: "pending" | "resolved" }
    };
  }
}

function emitRoomState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const playersArray = Object.entries(room.players).map(([id, p]) => ({
    id,
    name: p.name,
    animal: p.animal,
    score: p.score,
    isMiddle: id === room.middleId
  }));

  io.to(roomCode).emit("roomState", {
    roomCode,
    phase: room.phase,
    hostId: room.hostId,
    middleId: room.middleId,
    players: playersArray,
    duel: room.duel ? {
      middleId: room.duel.middleId,
      targetId: room.duel.targetId,
      status: room.duel.status
    } : null
  });
}

function chooseMiddleFromGuesses(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  if (!room.secretNumber) return;

  const secret = room.secretNumber;
  let bestId = null;
  let bestDiff = Infinity;

  for (const [id, guess] of Object.entries(room.guesses)) {
    const diff = Math.abs(guess - secret);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestId = id;
    }
  }

  if (bestId) {
    room.middleId = bestId;
    room.phase = "playing";
  }
  room.secretNumber = null;
  room.guesses = {};
  emitRoomState(roomCode);
}

io.on("connection", (socket) => {
  // Keep track of which room this socket is in
  let currentRoom = null;

  socket.on("joinRoom", ({ roomCode, playerName, animalName }, callback) => {
    if (!roomCode || !playerName || !animalName) {
      if (callback) callback({ ok: false, error: "Missing data" });
      return;
    }

    roomCode = roomCode.toUpperCase().trim();
    createRoomIfNeeded(roomCode);
    const room = rooms[roomCode];

    // Host is first player
    if (!room.hostId) {
      room.hostId = socket.id;
    }

    room.players[socket.id] = {
      name: playerName.trim(),
      animal: animalName.trim(),
      score: 0
    };

    socket.join(roomCode);
    currentRoom = roomCode;

    emitRoomState(roomCode);

    if (callback) callback({ ok: true, isHost: socket.id === room.hostId });
  });

  socket.on("startGuessPhase", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (socket.id !== room.hostId) return;

    room.phase = "guessing";
    room.secretNumber = Math.floor(Math.random() * 20) + 1; // 1-20
    room.guesses = {};

    io.to(roomCode).emit("guessPhaseStarted", {
      message: "Guess a number 1–20 to decide who starts in the middle!"
    });

    emitRoomState(roomCode);
  });

  socket.on("submitGuess", ({ roomCode, guess }) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (room.phase !== "guessing") return;
    if (!room.players[socket.id]) return;

    const num = Number(guess);
    if (!Number.isInteger(num) || num < 1 || num > 20) return;

    room.guesses[socket.id] = num;

    // If everyone has guessed, choose middle
    if (Object.keys(room.guesses).length === Object.keys(room.players).length) {
      chooseMiddleFromGuesses(roomCode);
    } else {
      emitRoomState(roomCode);
    }
  });

  // Middle calls a target: start a duel (10s timer handled on client)
  socket.on("middleCall", ({ roomCode, targetId }) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (room.phase !== "playing") return;
    if (socket.id !== room.middleId) return;
    if (!room.players[targetId]) return;

    room.duel = {
      middleId: room.middleId,
      targetId,
      status: "pending"
    };

    io.to(roomCode).emit("duelStarted", {
      middleId: room.middleId,
      targetId,
      durationMs: 10000 // 10 seconds
    });

    emitRoomState(roomCode);
  });

  // Middle claims they tagged in time (target did not escape)
  socket.on("middleSuccess", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || !room.duel) return;
    if (room.duel.status !== "pending") return;

    const { middleId, targetId } = room.duel;
    if (socket.id !== middleId) return;

    // Target was not successful -> target loses 5 points
    const middle = room.players[middleId];
    const target = room.players[targetId];
    if (!middle || !target) return;

    target.score -= 5;

    // Swap animal names (target takes middle's animal)
    const tempAnimal = middle.animal;
    middle.animal = target.animal;
    target.animal = tempAnimal;

    // Target becomes new middle
    room.middleId = targetId;

    room.duel.status = "resolved";

    io.to(roomCode).emit("duelResolved", {
      result: "middleTagged",
      middleId,
      newMiddleId: targetId,
      targetId
    });

    emitRoomState(roomCode);
  });

  // Target says they escaped (called another animal in time)
  socket.on("targetEscape", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || !room.duel) return;
    if (room.duel.status !== "pending") return;

    const { middleId, targetId } = room.duel;
    if (socket.id !== targetId) return;

    const middle = room.players[middleId];
    const target = room.players[targetId];
    if (!middle || !target) return;

    // Middle failed -> middle loses 5 points
    middle.score -= 5;

    room.duel.status = "resolved";

    io.to(roomCode).emit("duelResolved", {
      result: "targetEscaped",
      middleId,
      targetId
    });

    emitRoomState(roomCode);
  });

  // Timeout – assume middle failed to tag
  socket.on("duelTimeout", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || !room.duel) return;
    if (room.duel.status !== "pending") return;

    const { middleId, targetId } = room.duel;
    const middle = room.players[middleId];

    if (middle) {
      middle.score -= 5;
    }

    room.duel.status = "resolved";

    io.to(roomCode).emit("duelResolved", {
      result: "timeout",
      middleId,
      targetId
    });

    emitRoomState(roomCode);
  });

  socket.on("disconnect", () => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room) return;

    delete room.players[socket.id];

    // If middle left, clear middle
    if (room.middleId === socket.id) {
      room.middleId = null;
    }

    // If host left, assign new host
    if (room.hostId === socket.id) {
      const ids = Object.keys(room.players);
      room.hostId = ids.length > 0 ? ids[0] : null;
    }

    // Reset duel if one participant left
    if (room.duel && (room.duel.middleId === socket.id || room.duel.targetId === socket.id)) {
      room.duel = null;
    }

    // Delete room if empty
    if (Object.keys(room.players).length === 0) {
      delete rooms[currentRoom];
    } else {
      emitRoomState(currentRoom);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
