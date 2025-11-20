const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// --- Game State ---

// rooms[code] = {
//   code,
//   hostId,
//   players: {
//     socketId: { name, animal, joinedAt }
//   },
//   calledAnimals: new Set(),
//   state: 'lobby' | 'started'
// }
const rooms = {};

// Decoy animals (global reserved names)
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
  "hedgehog"
];

// Utility: generate simple 4-char room code
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
    animal: p.animal
  }));
}

function broadcastPlayerList(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  io.to(roomCode).emit("playerListUpdate", {
    roomCode,
    players: getRoomPlayers(roomCode)
  });
}

io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);

  // Host creates room
  socket.on("createRoom", ({ nickname }) => {
    const roomCode = generateRoomCode();
    rooms[roomCode] = {
      code: roomCode,
      hostId: socket.id,
      players: {},
      calledAnimals: new Set(),
      state: "lobby"
    };

    rooms[roomCode].players[socket.id] = {
      name: nickname || "Host",
      animal: null,
      joinedAt: Date.now()
    };

    socket.join(roomCode);

    socket.emit("roomCreated", {
      roomCode,
      isHost: true
    });

    broadcastPlayerList(roomCode);
    console.log(`Room created: ${roomCode} by ${socket.id}`);
  });

  // Player joins room
  socket.on("joinRoom", ({ roomCode, nickname }) => {
    roomCode = (roomCode || "").toUpperCase();
    const room = rooms[roomCode];
    if (!room) {
      socket.emit("joinError", { message: "Room not found." });
      return;
    }

    room.players[socket.id] = {
      name: nickname || "Player",
      animal: null,
      joinedAt: Date.now()
    };

    socket.join(roomCode);
    socket.emit("joinedRoom", {
      roomCode,
      isHost: room.hostId === socket.id
    });
    broadcastPlayerList(roomCode);
    console.log(`Socket ${socket.id} joined room ${roomCode}`);
  });

  // Player chooses an animal
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

    const animalLower = animal.toLowerCase();
    const decoySet = new Set(decoyAnimals.map((a) => a.toLowerCase()));

    // Cannot be a decoy
    if (decoySet.has(animalLower)) {
      socket.emit("animalRejected", {
        reason: "That animal is reserved as a decoy. Choose another!"
      });
      return;
    }

    // Cannot duplicate any other player's animal in this room
    const players = room.players;
    for (const [sid, p] of Object.entries(players)) {
      if (sid === socket.id) continue;
      if (p.animal && p.animal.toLowerCase() === animalLower) {
        socket.emit("animalRejected", {
          reason: "That animal is already taken by another player."
        });
        return;
      }
    }

    // All good, assign
    players[socket.id].animal = animal;
    socket.emit("animalAccepted", { animal });
    broadcastPlayerList(roomCode);
    console.log(`In room ${roomCode}, ${socket.id} picked animal ${animal}`);
  });

  // Host starts the game
  socket.on("startGame", ({ roomCode }) => {
    roomCode = (roomCode || "").toUpperCase();
    const room = rooms[roomCode];
    if (!room) return;
    if (room.hostId !== socket.id) return;

    room.state = "started";
    room.calledAnimals = new Set();
    io.to(roomCode).emit("gameStarted", { roomCode });
    console.log(`Game started in room ${roomCode}`);
  });

  // Host calls a random player's animal (no decoys)
  socket.on("callRandomAnimal", ({ roomCode }) => {
    roomCode = (roomCode || "").toUpperCase();
    const room = rooms[roomCode];
    if (!room) return;
    if (room.hostId !== socket.id) return;

    const players = getRoomPlayers(roomCode).filter((p) => p.animal);
    const uncalled = players.filter(
      (p) => !room.calledAnimals.has(p.animal.toLowerCase())
    );

    if (uncalled.length === 0) {
      socket.emit("callError", { message: "All animals have been called!" });
      return;
    }

    const chosen = uncalled[Math.floor(Math.random() * uncalled.length)];
    room.calledAnimals.add(chosen.animal.toLowerCase());

    io.to(roomCode).emit("animalCalled", {
      animal: chosen.animal,
      playerName: chosen.name,
      socketId: chosen.socketId
    });

    console.log(`In room ${roomCode}, called animal: ${chosen.animal}`);
  });

  // Host calls with decoys (1 real + 2 decoys)
  socket.on("callAnimalWithDecoys", ({ roomCode }) => {
    roomCode = (roomCode || "").toUpperCase();
    const room = rooms[roomCode];
    if (!room) return;
    if (room.hostId !== socket.id) return;

    const players = getRoomPlayers(roomCode).filter((p) => p.animal);
    const uncalled = players.filter(
      (p) => !room.calledAnimals.has(p.animal.toLowerCase())
    );

    if (uncalled.length === 0) {
      socket.emit("callError", { message: "All animals have been called!" });
      return;
    }

    const chosen = uncalled[Math.floor(Math.random() * uncalled.length)];
    room.calledAnimals.add(chosen.animal.toLowerCase());

    const playerAnimalSet = new Set(
      players.map((p) => p.animal.toLowerCase())
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

    io.to(roomCode).emit("animalCalledWithDecoys", {
      correctAnimal: chosen.animal,
      options,
      playerName: chosen.name,
      socketId: chosen.socketId
    });

    console.log(
      `In room ${roomCode}, called animal with decoys: ${chosen.animal} vs [${chosenDecoys.join(
        ", "
      )}]`
    );
  });

  // Handle disconnect
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
          console.log(`Room ${code} closed because host left.`);
        } else {
          broadcastPlayerList(code);
        }
        break;
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Aardvark Animal Game running at http://localhost:${PORT}`);
});
