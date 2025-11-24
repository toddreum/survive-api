const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*'
  }
});

const PORT = process.env.PORT || 3000;

// Optional: serve /public if you ever put files there,
// but your main frontend will be on cPanel.
app.use(express.static(path.join(__dirname, 'public')));

// --- GAME STATE ---

const MAX_PLAYERS = 4;

const BOARD_TILES = [
  { name: 'Core Plaza', type: 'start', desc: 'Safe zone. No effects.' },
  { name: 'Water Plant', type: 'water+', desc: 'You secure water supply.' },
  { name: 'Food District', type: 'food+', desc: 'You stockpile food.' },
  { name: 'Black Market', type: 'credits+', desc: 'Risky cash boost.' },
  { name: 'Media Tower', type: 'influence+', desc: 'You gain public influence.' },
  { name: 'Power Grid', type: 'energy+', desc: 'You stabilize the power.' },
  { name: 'Riot Zone', type: 'stability-', desc: 'Unrest hits the city.' },
  { name: 'Hospital Hub', type: 'stability+', desc: 'You support health services.' },
  { name: 'Security Barracks', type: 'security+', desc: 'You strengthen defenses.' },
  { name: 'Smog Alley', type: 'stability-', desc: 'Pollution spikes.' },
  { name: 'Harbor Gate', type: 'mixed+', desc: 'Trade winds in your favor.' },
  { name: 'Data Center', type: 'influence+', desc: 'You tap into the network.' }
];

let gameState = createInitialGameState();

function createInitialGameState() {
  return {
    players: {},        // socketId -> player
    playerOrder: [],    // array of socketIds in turn order
    currentPlayerIndex: 0,
    cityStability: 80,
    started: false,
    log: []
  };
}

const COLORS = ['#ff4b4b', '#4bff7a', '#4ba3ff', '#ffd84b'];

function nextColor(index) {
  return COLORS[index % COLORS.length];
}

function isPlayersTurn(socketId) {
  const idx = gameState.currentPlayerIndex;
  return gameState.playerOrder[idx] === socketId;
}

function broadcastState() {
  io.emit('gameState', {
    players: gameState.players,
    playerOrder: gameState.playerOrder,
    currentPlayerId: gameState.playerOrder[gameState.currentPlayerIndex],
    cityStability: gameState.cityStability,
    board: BOARD_TILES,
    log: gameState.log.slice(-20) // last 20 lines
  });
}

function addLog(message) {
  const entry = { message, ts: Date.now() };
  gameState.log.push(entry);
}

function applyTileEffect(player, tile) {
  switch (tile.type) {
    case 'water+':
      player.water += 2;
      gameState.cityStability += 1;
      addLog(`${player.name} boosted water reserves at ${tile.name}.`);
      break;
    case 'food+':
      player.food += 2;
      gameState.cityStability += 1;
      addLog(`${player.name} secured food supplies at ${tile.name}.`);
      break;
    case 'credits+':
      player.credits += 3;
      gameState.cityStability -= 1;
      addLog(`${player.name} cashed in at the ${tile.name}, but tension rises.`);
      break;
    case 'influence+':
      player.influence += 2;
      addLog(`${player.name} gained influence at ${tile.name}.`);
      break;
    case 'energy+':
      player.energy += 2;
      gameState.cityStability += 1;
      addLog(`${player.name} stabilized the grid at ${tile.name}.`);
      break;
    case 'security+':
      player.security += 2;
      gameState.cityStability += 1;
      addLog(`${player.name} increased security at ${tile.name}.`);
      break;
    case 'stability-':
      gameState.cityStability -= 3;
      addLog(`${player.name} triggered unrest at ${tile.name}. City stability falls!`);
      break;
    case 'stability+':
      gameState.cityStability += 3;
      addLog(`${player.name} supported the city at ${tile.name}. Stability improves.`);
      break;
    case 'mixed+':
      player.credits += 2;
      player.food += 1;
      gameState.cityStability += 1;
      addLog(`${player.name} profited from trade at ${tile.name}.`);
      break;
    case 'start':
    default:
      addLog(`${player.name} rests at ${tile.name}.`);
      break;
  }

  if (gameState.cityStability > 100) gameState.cityStability = 100;
  if (gameState.cityStability < 0) gameState.cityStability = 0;
}

// --- SOCKET.IO ---

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('joinGame', (name) => {
    if (!name || typeof name !== 'string') {
      name = 'Survivor ' + socket.id.slice(0, 4);
    }

    // if player already exists (reconnect)
    if (!gameState.players[socket.id]) {
      if (gameState.playerOrder.length >= MAX_PLAYERS) {
        socket.emit('errorMessage', 'Game room is full.');
        return;
      }

      const color = nextColor(gameState.playerOrder.length);
      const newPlayer = {
        id: socket.id,
        name: name.trim().slice(0, 20),
        color,
        position: 0,
        credits: 5,
        water: 2,
        food: 2,
        energy: 1,
        influence: 0,
        security: 0
      };

      gameState.players[socket.id] = newPlayer;
      gameState.playerOrder.push(socket.id);

      addLog(`${newPlayer.name} joined the city.`);
    }

    if (gameState.playerOrder.length >= 2 && !gameState.started) {
      gameState.started = true;
      addLog('The struggle for the last city begins.');
    }

    broadcastState();
  });

  socket.on('rollDice', () => {
    if (!gameState.started) {
      socket.emit('errorMessage', 'Waiting for more players...');
      return;
    }
    if (!isPlayersTurn(socket.id)) {
      socket.emit('errorMessage', 'It is not your turn.');
      return;
    }

    const player = gameState.players[socket.id];
    if (!player) return;

    const roll = Math.floor(Math.random() * 6) + 1;
    const oldPos = player.position;
    const newPos = (oldPos + roll) % BOARD_TILES.length;
    player.position = newPos;

    const tile = BOARD_TILES[newPos];
    applyTileEffect(player, tile);

    addLog(`${player.name} rolled a ${roll} and moved to ${tile.name}.`);

    // Check for collapse
    if (gameState.cityStability <= 0) {
      addLog('The city collapses! Game over.');
      io.emit('gameOver', {
        reason: 'collapse',
        log: gameState.log
      });
      gameState = createInitialGameState();
      broadcastState();
      return;
    }

    io.emit('diceResult', {
      playerId: socket.id,
      roll,
      newPosition: newPos,
      tileName: tile.name,
      tileType: tile.type
    });

    // Next player's turn
    gameState.currentPlayerIndex =
      (gameState.currentPlayerIndex + 1) % gameState.playerOrder.length;

    broadcastState();
  });

  socket.on('sendChat', (text) => {
    if (!text || typeof text !== 'string') return;
    const player = gameState.players[socket.id];
    const name = player ? player.name : 'Spectator';
    io.emit('chatMessage', {
      from: name,
      text: text.slice(0, 200),
      ts: Date.now()
    });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    const player = gameState.players[socket.id];
    if (player) {
      addLog(`${player.name} left the city.`);
      delete gameState.players[socket.id];
      gameState.playerOrder = gameState.playerOrder.filter(
        (id) => id !== socket.id
      );

      if (gameState.playerOrder.length === 0) {
        gameState = createInitialGameState();
      } else {
        if (gameState.currentPlayerIndex >= gameState.playerOrder.length) {
          gameState.currentPlayerIndex = 0;
        }
      }
      broadcastState();
    }
  });
});

server.listen(PORT, () => {
  console.log('Survive game server running on port', PORT);
});
