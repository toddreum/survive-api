// server.js
// Simple room-based sync server for SURVIVE – Neon Aardvark Tag

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 10000;

const app = express();

// --- CORS for HTTP routes ---
app.use(
  cors({
    origin: "*",           // you can lock this down later
    methods: ["GET", "POST"],
  })
);

app.use(express.json());

// Simple health check
app.get("/", (req, res) => {
  res.json({ ok: true, message: "SURVIVE API online" });
});

// Optional debug route to see room codes (no sensitive data)
app.get("/rooms", (req, res) => {
  res.json({
    rooms: Object.values(rooms).map((r) => ({
      code: r.code,
      hostId: r.hostId,
      playerCount: r.players.length,
      lastUpdated: r.lastUpdated,
    })),
  });
});

// --- HTTP server + Socket.IO ---
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",           // front-end origin(s) allowed
    methods: ["GET", "POST"],
  },
});

// In-memory room store
// room = {
//   code,
//   hostId,
//   createdAt,
//   lastUpdated,
//   players: [{ id, name }],
//   state: { ... arbitrary game state from host ... }
// }
const rooms = {};

// Helper functions
function createRoom(code, hostSocket, hostName) {
  const now = Date.now();
  const room = {
    code,
    hostId: hostSocket.id,
    createdAt: now,
    lastUpdated: now,
    players: [
      {
        id: hostSocket.id,
        name: hostName || "Host",
      },
    ],
    state: null,
  };
  rooms[code] = room;
  hostSocket.join(code);
  return room;
}

function getRoom(code) {
  return rooms[code] || null;
}

function removePlayerFromRoom(socketId) {
  let affectedRoomCode = null;
  Object.values(rooms).forEach((room) => {
    const before = room.players.length;
    room.players = room.players.filter((p) => p.id !== socketId);
    if (room.players.length !== before) {
      affectedRoomCode = room.code;
      room.lastUpdated = Date.now();
    }
  });

  if (!affectedRoomCode) return;

  const room = rooms[affectedRoomCode];

  // If room is empty, delete it
  if (!room.players.length) {
    delete rooms[affectedRoomCode];
    return;
  }

  // If host left, reassign host to first remaining player
  if (!room.players.some((p) => p.id === room.hostId)) {
    room.hostId = room.players[0].id;
  }

  broadcastRoomState(room.code);
}

function sanitizeRoomForClient(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    players: room.players,
    state: room.state || null,
    lastUpdated: room.lastUpdated,
  };
}

function broadcastRoomState(code) {
  const room = getRoom(code);
  if (!room) return;
  const payload = sanitizeRoomForClient(room);
  io.to(code).emit("room:state", payload);
}

// --- Socket.IO events ---

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // Host a new room
  // payload: { roomCode, playerName }
  socket.on("room:host", ({ roomCode, playerName }) => {
    try {
      const code = (roomCode || "").trim().toUpperCase();
      if (!code || code.length > 10) {
        socket.emit("room:error", { message: "Invalid room code." });
        return;
      }

      if (rooms[code] && rooms[code].players.length > 0) {
        socket.emit("room:error", {
          message: "Room already exists and is not empty. Pick another code or join.",
        });
        return;
      }

      const room = createRoom(code, socket, playerName);
      console.log(`Room ${code} hosted by ${socket.id}`);

      socket.emit("room:joined", {
        code: room.code,
        hostId: room.hostId,
        you: socket.id,
      });

      broadcastRoomState(code);
    } catch (err) {
      console.error("room:host error", err);
      socket.emit("room:error", { message: "Failed to host room." });
    }
  });

  // Join an existing room
  // payload: { roomCode, playerName }
  socket.on("room:join", ({ roomCode, playerName }) => {
    try {
      const code = (roomCode || "").trim().toUpperCase();
      if (!code) {
        socket.emit("room:error", { message: "Room code is required." });
        return;
      }

      const room = getRoom(code);
      if (!room) {
        socket.emit("room:error", { message: "Room not found." });
        return;
      }

      if (room.players.length >= 10) {
        socket.emit("room:error", { message: "Room is full (max 10 players)." });
        return;
      }

      // Check if this socket is already in the room
      if (!room.players.some((p) => p.id === socket.id)) {
        room.players.push({
          id: socket.id,
          name: playerName || `Player ${room.players.length + 1}`,
        });
        room.lastUpdated = Date.now();
      }

      socket.join(code);

      socket.emit("room:joined", {
        code: room.code,
        hostId: room.hostId,
        you: socket.id,
      });

      broadcastRoomState(code);
      console.log(`Socket ${socket.id} joined room ${code}`);
    } catch (err) {
      console.error("room:join error", err);
      socket.emit("room:error", { message: "Failed to join room." });
    }
  });

  // Client leaves a room explicitly
  // payload: { roomCode }
  socket.on("room:leave", ({ roomCode }) => {
    try {
      const code = (roomCode || "").trim().toUpperCase();
      if (!code) return;

      const room = getRoom(code);
      if (!room) return;

      socket.leave(code);
      room.players = room.players.filter((p) => p.id !== socket.id);
      room.lastUpdated = Date.now();

      // Room empty? delete
      if (!room.players.length) {
        delete rooms[code];
      } else {
        // Host left? reassign
        if (!room.players.some((p) => p.id === room.hostId)) {
          room.hostId = room.players[0].id;
        }
        broadcastRoomState(code);
      }
    } catch (err) {
      console.error("room:leave error", err);
    }
  });

  // Host sends authoritative game state to sync to everyone
  // payload: { roomCode, state }
  // "state" should contain the board / players / phase / timer etc.
  socket.on("room:updateState", ({ roomCode, state }) => {
    try {
      const code = (roomCode || "").trim().toUpperCase();
      const room = getRoom(code);
      if (!room) return;

      // Only host is allowed to push state
      if (socket.id !== room.hostId) {
        socket.emit("room:error", {
          message: "Only the host can update the game state.",
        });
        return;
      }

      // Store and broadcast
      room.state = state || null;
      room.lastUpdated = Date.now();
      broadcastRoomState(code);
    } catch (err) {
      console.error("room:updateState error", err);
      socket.emit("room:error", { message: "Failed to update state." });
    }
  });

  // Clients can request the latest state (e.g. after reconnect)
  // payload: { roomCode }
  socket.on("room:requestState", ({ roomCode }) => {
    const code = (roomCode || "").trim().toUpperCase();
    const room = getRoom(code);
    if (!room) {
      socket.emit("room:error", { message: "Room not found." });
      return;
    }
    const payload = sanitizeRoomForClient(room);
    socket.emit("room:state", payload);
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    removePlayerFromRoom(socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`SURVIVE API listening on port ${PORT}`);
});
