import React, { useState } from 'react';
import GameBoard from './GameBoard';
import './styles.css';

function App() {
  const [screen, setScreen] = useState('menu');
  const [playerName, setPlayerName] = useState('');
  const [timer, setTimer] = useState(600);

  const startGame = () => setScreen('game');

  return (
    <div className="arcade-bg">
      <img src="/logo.png" className="logo" alt="Survive.com Logo" />
      {screen === 'menu' && (
        <div className="menu">
          <h1>Survive.com</h1>
          <input
            placeholder="Your Name"
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
            className="input"
          />
          <select onChange={(e) => setTimer(Number(e.target.value))} className="input">
            <option value={600}>10 Minutes</option>
            <option value={300}>5 Minutes</option>
            <option value={120}>2 Minutes</option>
          </select>
          <button className="button" onClick={startGame}>
            Start Game
          </button>
        </div>
      )}
      {screen === 'game' && (
        <GameBoard playerName={playerName} timer={timer} />
      )}
    </div>
  );
}

export default App;
