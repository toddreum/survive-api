// server.js
// SURVIVE – Neon Aardvark Tag backend
// Multi-room Socket.IO sync for up to 10 clients per room

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 10000;

const app = express();

// ----- HTTP + CORS -----
app.use(
  cors({
    origin: "*", // tighten to your domain later if you want
    methods: ["GET", "POST"]
  })
);
app.use(express.json());

// In-memory rooms map must be defined before /rooms & sockets
// Each room:
// {
//   code: "AB12",
//   hostId: "<socket.id>",
//   hostName: "Host",
//   clients: Set<socketId>,
//   state: { ...gameStateFromHost... } | null,
//   createdAt: number,
//   updatedAt: number
// }
const rooms = new Map();

// Simple health check
app.get("/", (req, res) => {
  res.json({ ok: true, message: "SURVIVE API online" });
});

// Optional debug endpoint – shows active rooms (no game details)
app.get("/rooms", (req, res) => {
  const summary = [];
  for (const [code, room] of rooms.entries()) {
    summary.push({
      code,
      hostId: room.hostId,
      hostName: room.hostName,
      clientCount: room.clients.size,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt
    });
  }
  res.json({ rooms: summary });
});

// ----- HTTP server + Socket.IO -----
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// ----- Room helpers -----

// Helper: generate a short room code like "AB12"
function generateRoomCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0 / 1 / O / I
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function createRoom(hostSocket, hostName) {
  // Make sure we don't clash codes
  let code;
  do {
    code = generateRoomCode();
  } while (rooms.has(code));

  const now = Date.now();
  const room = {
    code,
    hostId: hostSocket.id,
    hostName: hostName || "Host",
    clients: new Set([hostSocket.id]),
    state: null,
    createdAt: now,
    updatedAt: now
  };

  rooms.set(code, room);
  hostSocket.join(code);

  return room;
}

function getRoom(codeRaw) {
  const code = (codeRaw || "").trim().toUpperCase();
  if (!code) return null;
  return rooms.get(code) || null;
}

function removeClientFromRooms(socketId) {
  const affectedRooms = [];

  for (const [code, room] of rooms.entries()) {
    if (room.clients.has(socketId)) {
      room.clients.delete(socketId);
      room.updatedAt = Date.now();
      affectedRooms.push({ code, room });
    }
  }

  for (const { code, room } of affectedRooms) {
    // If host left this room
    if (room.hostId === socketId) {
      // Tell remaining clients the room is closed
      io.to(code).emit("roomClosed");
      rooms.delete(code);
      console.log(`Room ${code} closed because host disconnected.`);
      continue;
    }

    // If no clients left at all, just delete the room
    if (room.clients.size === 0) {
      rooms.delete(code);
      console.log(`Room ${code} deleted (no clients left).`);
    }
  }
}

// ----- Socket.IO events -----
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // Keep-alive / heartbeat (optional but helpful on Render)
  socket.on("pingHost", () => {
    socket.emit("pongHost");
  });

  // Client wants to HOST a new room
  // payload: { name }
  socket.on("createRoom", ({ name } = {}) => {
    try {
      // If this socket was already in any room, clean it up
      removeClientFromRooms(socket.id);

      const hostName = (name || "").toString().trim() || "Host";
      const room = createRoom(socket, hostName);

      console.log(`Room ${room.code} created by ${socket.id} (${hostName})`);

      socket.emit("roomJoined", {
        roomCode: room.code,
        playerId: socket.id,
        isHost: true,
        state: room.state // null at first
      });
    } catch (err) {
      console.error("createRoom error:", err);
      socket.emit("errorMessage", "Failed to create room. Please try again.");
    }
  });

  // Client wants to JOIN an existing room
  // payload: { roomCode, name }
  socket.on("joinRoom", ({ roomCode, name } = {}) => {
    try {
      const room = getRoom(roomCode);
      if (!room) {
        socket.emit("errorMessage", "Room not found. Check the code.");
        return;
      }

      // Limit total clients to 10 (host + viewers)
      if (!room.clients.has(socket.id) && room.clients.size >= 10) {
        socket.emit("errorMessage", "Room is full (max 10 total).");
        return;
      }

      // Add client to room if not already tracked
      if (!room.clients.has(socket.id)) {
        room.clients.add(socket.id);
        room.updatedAt = Date.now();
      }

      socket.join(room.code);

      console.log(
        `Socket ${socket.id} (${name || "Viewer"}) joined room ${room.code}`
      );

      socket.emit("roomJoined", {
        roomCode: room.code,
        playerId: socket.id,
        isHost: socket.id === room.hostId,
        state: room.state // last known game state from host (if any)
      });
    } catch (err) {
      console.error("joinRoom error:", err);
      socket.emit("errorMessage", "Failed to join room. Please try again.");
    }
  });

  // Host pushes authoritative game state
  // payload: { roomCode, state }
  socket.on("hostStateUpdate", ({ roomCode, state } = {}) => {
    try {
      const room = getRoom(roomCode);
      if (!room) {
        socket.emit("errorMessage", "Room not found for state update.");
        return;
      }

      // Only the host of that room can send state updates
      if (socket.id !== room.hostId) {
        socket.emit("errorMessage", "Only the host can update the game state.");
        return;
      }

      // Save and broadcast the new state
      room.state = state || null;
      room.updatedAt = Date.now();

      // Send to everyone in the room (including host)
      io.to(room.code).emit("stateUpdate", room.state);
    } catch (err) {
      console.error("hostStateUpdate error:", err);
      socket.emit("errorMessage", "Failed to sync game state.");
    }
  });

  // Optional: future per-player events from clients
  // payload can be anything; for now we just echo to the host
  socket.on("playerAction", ({ roomCode, action, data } = {}) => {
    const room = getRoom(roomCode);
    if (!room) return;

    // Forward this to the host only (host might use later)
    io.to(room.hostId).emit("playerAction", {
      from: socket.id,
      action,
      data
    });
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    removeClientFromRooms(socket.id);
  });
});

// Heartbeat broadcast to keep Render instance warm
setInterval(() => {
  io.emit("pingHost");
}, 15000);

server.listen(PORT, () => {
  console.log(`SURVIVE API listening on port ${PORT}`);
});
