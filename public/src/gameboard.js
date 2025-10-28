import { socket } from './socket';

// Example: Call a player
socket.emit('animalSwitch', { gameId, fromPlayer, toPlayer }, (result) => {
  // handle result/game state update
});

// Example: Tap a player
socket.emit('tapPlayer', { gameId, targetPlayer }, (result) => {
  // handle result/game state update
});
