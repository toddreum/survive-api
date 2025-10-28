const { v4: uuidv4 } = require('uuid');

function createGame(playerName, gameTimer) {
  const gameId = uuidv4();
  const initialPlayer = {
    name: playerName,
    points: 20,
    animal: 'Aardvark',
    isCenter: true,
    hasBoost: false,
  };
  global.GAMES = global.GAMES || {};
  global.GAMES[gameId] = {
    id: gameId,
    timer: gameTimer,
    players: [initialPlayer],
    started: false,
    centerIndex: 0,
    startTime: Date.now(),
    lastCalled: null,
  };
  return gameId;
}

function joinGame(game, playerName) {
  if (game.players.find((p) => p.name === playerName)) return;
  game.players.push({
    name: playerName,
    points: 20,
    animal: null,
    isCenter: false,
    hasBoost: false,
  });
}

function animalSwitch(game, fromPlayer, toPlayer) {
  const fromIdx = game.players.findIndex((p) => p.name === fromPlayer);
  const toIdx = game.players.findIndex((p) => p.name === toPlayer);
  if (fromIdx === -1 || toIdx === -1) return { error: 'Player not found' };
  const tempAnimal = game.players[fromIdx].animal;
  game.players[fromIdx].animal = game.players[toIdx].animal;
  game.players[toIdx].animal = tempAnimal;
  game.players[fromIdx].isCenter = false;
  game.players[toIdx].isCenter = true;
  game.centerIndex = toIdx;
  game.players[toIdx].points -= 2;
  return { game };
}

function tapPlayer(game, targetPlayer) {
  const centerIdx = game.centerIndex;
  const centerPlayer = game.players[centerIdx];
  const targetIdx = game.players.findIndex((p) => p.name === targetPlayer);
  if (targetIdx === -1) return { error: 'Target not found' };

  const tempAnimal = centerPlayer.animal;
  centerPlayer.animal = game.players[targetIdx].animal;
  game.players[targetIdx].animal = tempAnimal;

  centerPlayer.isCenter = false;
  game.players[targetIdx].isCenter = true;
  game.centerIndex = targetIdx;
  game.players[targetIdx].points -= 2;

  return { game };
}

function buyBoost(game, playerName) {
  const player = game.players.find((p) => p.name === playerName);
  if (player && !player.hasBoost) {
    player.points += 5;
    player.hasBoost = true;
    return { success: true, points: player.points };
  }
  return { success: false, message: 'Already used boost or player not found' };
}

module.exports = { createGame, joinGame, animalSwitch, buyBoost, tapPlayer };
