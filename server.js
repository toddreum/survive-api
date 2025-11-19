const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());

app.get("/", (req, res) => {
  res.send("Survive API is running");
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// rooms[code] = {
//   hostId: socket.id,
//   players: { socketId: { name, isHost } },
//   lastState: { players, phase, middleIndex, duel, gameEndTime }
// };
const rooms = {};

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 4; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("createRoom", ({ name }) => {
    let code;
    do {
      code = generateRoomCode();
    } while (rooms[code]);

    rooms[code] = {
      hostId: socket.id,
      players: {
        [socket.id]: { name: name || "Host", isHost: true }
      },
      lastState: null
    };

    socket.join(code);
    socket.emit("roomJoined", {
      roomCode: code,
      playerId: socket.id,
      isHost: true
    });

    console.log(`Room ${code} created by ${socket.id}`);
  });

  socket.on("joinRoom", ({ roomCode, name }) => {
    const code = (roomCode || "").toUpperCase();
    const room = rooms[code];
    if (!room) {
      socket.emit("errorMessage", "Room not found.");
      return;
    }
    if (Object.keys(room.players).length >= 10) {
      socket.emit("errorMessage", "Room is full (max 10 players).");
      return;
    }

    room.players[socket.id] = {
      name: name || "Player",
      isHost: false
    };

    socket.join(code);

    socket.emit("roomJoined", {
      roomCode: code,
      playerId: socket.id,
      isHost: false,
      state: room.lastState
    });

    io.to(room.hostId).emit("playerJoined", {
      roomCode: code,
      playerId: socket.id,
      name: name || "Player"
    });

    console.log(`Client ${socket.id} joined room ${code}`);
  });

  // Host pushes full game state to all others
  socket.on("hostStateUpdate", ({ roomCode, state }) => {
    const code = (roomCode || "").toUpperCase();
    const room = rooms[code];
    if (!room) return;
    if (room.hostId !== socket.id) return;

    room.lastState = state || null;
    // broadcast to everyone else in the room
    socket.to(code).emit("stateUpdate", state);
  });

  // Player sends some action (not fully used yet; this is for future per-player control)
  socket.on("playerAction", ({ roomCode, action }) => {
    const code = (roomCode || "").toUpperCase();
    const room = rooms[code];
    if (!room) return;
    io.to(room.hostId).emit("playerAction", {
      roomCode: code,
      fromPlayerId: socket.id,
      action
    });
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);

    for (const code of Object.keys(rooms)) {
      const room = rooms[code];
      if (!room) continue;
      if (!room.players[socket.id]) continue;

      const wasHost = room.hostId === socket.id;
      delete room.players[socket.id];

      if (wasHost) {
        io.to(code).emit("roomClosed");
        delete rooms[code];
        console.log(`Room ${code} closed (host disconnected).`);
      } else {
        io.to(room.hostId).emit("playerLeft", {
          roomCode: code,
          playerId: socket.id
        });
      }
    }
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("Survive API listening on port", PORT);
});
