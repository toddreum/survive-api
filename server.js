const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Serve static frontend from /public
app.use(express.static(path.join(__dirname, "public")));

const rooms = {}; // roomCode -> { players: [], hostId, currentTurnIndex, inProgress, timeoutId }

function createRoom(roomCode, hostId, hostName) {
  rooms[roomCode] = {
    hostId,
    inProgress: false,
    currentTurnIndex: 0,
    timeoutId: null,
    players: [
      {
        id: hostId,
        name: hostName || "Host",
        alive: true
      }
    ]
  };
}

function getRoom(roomCode) {
  return rooms[roomCode];
}

function broadcastRoomUpdate(roomCode) {
  const room = getRoom(roomCode);
  if (!room) return;

  io.to(roomCode).emit("roomUpdate", {
    roomCode,
    hostId: room.hostId,
    inProgress: room.inProgress,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      alive: p.alive
    })),
    currentTurnIndex: room.currentTurnIndex
  });
}

function startGame(roomCode) {
  const room = getRoom(roomCode);
  if (!room || room.inProgress || room.players.length === 0) return;

  room.inProgress = true;
  room.currentTurnIndex = 0;
  room.players.forEach((p) => (p.alive = true));

  io.to(roomCode).emit("gameStarted");
  startTurn(roomCode);
}

function getAlivePlayers(room) {
  return room.players.filter((p) => p.alive);
}

function startTurn(roomCode) {
  const room = getRoom(roomCode);
  if (!room) return;

  const alivePlayers = getAlivePlayers(room);
  if (alivePlayers.length <= 1) {
    endGame(roomCode);
    return;
  }

  if (
    !room.players[room.currentTurnIndex] ||
    !room.players[room.currentTurnIndex].alive
  ) {
    room.currentTurnIndex = room.players.findIndex((p) => p.alive);
  }

  const currentPlayer = room.players[room.currentTurnIndex];
  if (!currentPlayer || !currentPlayer.alive) {
    endGame(roomCode);
    return;
  }

  if (room.timeoutId) {
    clearTimeout(room.timeoutId);
    room.timeoutId = null;
  }

  const TURN_DURATION_MS = 15000; // 15 seconds

  io.to(roomCode).emit("turnChanged", {
    activePlayerId: currentPlayer.id,
    activePlayerName: currentPlayer.name,
    durationMs: TURN_DURATION_MS
  });

  room.timeoutId = setTimeout(() => {
    currentPlayer.alive = false;
    io.to(roomCode).emit("playerEliminated", {
      playerId: currentPlayer.id,
      name: currentPlayer.name,
      reason: "timeout"
    });
    advanceTurn(roomCode);
  }, TURN_DURATION_MS);
}

function advanceTurn(roomCode) {
  const room = getRoom(roomCode);
  if (!room) return;

  const alivePlayers = getAlivePlayers(room);
  if (alivePlayers.length <= 1) {
    endGame(roomCode);
    return;
  }

  let nextIndex = room.currentTurnIndex;
  const total = room.players.length;
  for (let i = 0; i < total; i++) {
    nextIndex = (nextIndex + 1) % total;
    if (room.players[nextIndex].alive) {
      room.currentTurnIndex = nextIndex;
      startTurn(roomCode);
      return;
    }
  }

  endGame(roomCode);
}

function endGame(roomCode) {
  const room = getRoom(roomCode);
  if (!room) return;

  if (room.timeoutId) {
    clearTimeout(room.timeoutId);
    room.timeoutId = null;
  }

  const alivePlayers = getAlivePlayers(room);
  let winner = null;
  if (alivePlayers.length === 1) {
    winner = alivePlayers[0];
  }

  io.to(roomCode).emit("gameOver", {
    winner: winner
      ? { id: winner.id, name: winner.name }
      : null
  });

  room.inProgress = false;
}

io.on("connection", (socket) => {
  socket.on("createRoom", ({ roomCode, playerName }) => {
    roomCode = (roomCode || "").trim().toUpperCase();
    if (!roomCode) {
      socket.emit("errorMessage", "Room code is required.");
      return;
    }
    if (rooms[roomCode]) {
      socket.emit("errorMessage", "Room code already exists. Choose another.");
      return;
    }
    createRoom(roomCode, socket.id, playerName);
    socket.join(roomCode);
    socket.emit("joinedRoom", { roomCode, playerId: socket.id });
    broadcastRoomUpdate(roomCode);
  });

  socket.on("joinRoom", ({ roomCode, playerName }) => {
    roomCode = (roomCode || "").trim().toUpperCase();
    const room = getRoom(roomCode);
    if (!room) {
      socket.emit("errorMessage", "Room not found.");
      return;
    }
    if (room.players.length >= 10) {
      socket.emit("errorMessage", "Room is full (max 10 players).");
      return;
    }
    if (room.inProgress) {
      socket.emit("errorMessage", "Game already started in this room.");
      return;
    }

    room.players.push({
      id: socket.id,
      name: playerName || "Player",
      alive: true
    });
    socket.join(roomCode);
    socket.emit("joinedRoom", { roomCode, playerId: socket.id });
    broadcastRoomUpdate(roomCode);
  });

  socket.on("startGame", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    if (socket.id !== room.hostId) {
      socket.emit("errorMessage", "Only the host can start the game.");
      return;
    }
    if (room.players.length < 2) {
      socket.emit("errorMessage", "Need at least 2 players to start.");
      return;
    }
    startGame(roomCode);
  });

  socket.on("submitWord", ({ roomCode, word }) => {
    const room = getRoom(roomCode);
    if (!room || !room.inProgress) return;

    const currentPlayer = room.players[room.currentTurnIndex];
    if (!currentPlayer || currentPlayer.id !== socket.id) {
      socket.emit("errorMessage", "It's not your turn.");
      return;
    }

    word = (word || "").trim();
    if (!word) {
      socket.emit("errorMessage", "You must type something to survive!");
      return;
    }

    io.to(roomCode).emit("wordSubmitted", {
      playerId: socket.id,
      playerName: currentPlayer.name,
      word
    });

    if (room.timeoutId) {
      clearTimeout(room.timeoutId);
      room.timeoutId = null;
    }
    advanceTurn(roomCode);
  });

  socket.on("disconnect", () => {
    for (const roomCode of Object.keys(rooms)) {
      const room = rooms[roomCode];
      const idx = room.players.findIndex((p) => p.id === socket.id);
      if (idx !== -1) {
        const wasHost = room.hostId === socket.id;
        room.players.splice(idx, 1);

        if (room.players.length === 0) {
          if (room.timeoutId) {
            clearTimeout(room.timeoutId);
          }
          delete rooms[roomCode];
          continue;
        }

        if (wasHost) {
          room.hostId = room.players[0].id;
        }

        if (room.currentTurnIndex >= room.players.length) {
          room.currentTurnIndex = 0;
        }

        broadcastRoomUpdate(roomCode);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Survive server running on port ${PORT}`);
});
