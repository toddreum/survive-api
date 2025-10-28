const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createGame, joinGame, animalSwitch, buyBoost, tapPlayer } = require('./game');
const stripeRoutes = require('./stripe');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

app.use('/stripe', stripeRoutes);

const games = {};

io.on('connection', (socket) => {
  socket.on('createGame', ({ playerName, gameTimer }, cb) => {
    const gameId = createGame(playerName, gameTimer);
    games[gameId] = games[gameId] || {};
    games[gameId].players = [playerName];
    cb({ gameId });
    socket.join(gameId);
    io.to(socket.id).emit('gameCreated', { gameId });
  });

  socket.on('joinGame', ({ gameId, playerName }, cb) => {
    if (games[gameId]) {
      joinGame(games[gameId], playerName);
      socket.join(gameId);
      cb({ success: true });
      io.in(gameId).emit('playerJoined', { playerName });
    } else {
      cb({ success: false, message: 'Game not found' });
    }
  });

  socket.on('animalSwitch', ({ gameId, fromPlayer, toPlayer }, cb) => {
    const result = animalSwitch(games[gameId], fromPlayer, toPlayer);
    io.in(gameId).emit('animalSwitched', result);
    cb(result);
  });

  socket.on('tapPlayer', ({ gameId, targetPlayer }, cb) => {
    const result = tapPlayer(games[gameId], targetPlayer);
    io.in(gameId).emit('playerTapped', result);
    cb(result);
  });

  socket.on('buyBoost', ({ gameId, playerName }, cb) => {
    const result = buyBoost(games[gameId], playerName);
    cb(result);
  });

  socket.on('disconnect', () => {});
});

server.listen(4000, () => console.log('Backend running on http://localhost:4000'));
