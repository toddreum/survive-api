import React, { useState, useEffect, useRef } from 'react';
import Timer from './Timer';
import AnimalSelector from './AnimalSelector';
import StripeBoost from './StripeBoost';
import { socket } from './socket';
import './styles.css';

function GameBoard({ playerName, timer }) {
  const [animals, setAnimals] = useState(['Aardvark', 'Lion', 'Tiger', 'Bear', 'Wolf']);
  const [centerIdx, setCenterIdx] = useState(0);
  const [score, setScore] = useState(20);
  const [round, setRound] = useState(1);
  const [showBoost, setShowBoost] = useState(false);
  const [calledIdx, setCalledIdx] = useState(null);
  const timeoutId = useRef();

  // Simulate animal call and tap sequence
  useEffect(() => {
    if (calledIdx === null) return;
    timeoutId.current = setTimeout(() => {
      // After 10 seconds, center must tap called player
      handleTap(calledIdx);
    }, 10000);
    return () => clearTimeout(timeoutId.current);
  }, [calledIdx]);

  const callAnimal = (idx) => {
    if (idx === centerIdx) return;
    setCalledIdx(idx);
    // Here you would emit socket event to backend
    // socket.emit('animalSwitch', { gameId, fromPlayer: playerName, toPlayer: animals[idx] }, (result) => { ... });
  };

  const handleTap = (idx) => {
    // Center taps called player, swaps spots & names
    let newAnimals = [...animals];
    [newAnimals[centerIdx], newAnimals[idx]] = [newAnimals[idx], newAnimals[centerIdx]];
    setAnimals(newAnimals);
    setCenterIdx(idx);
    setScore((s) => (s > 0 ? s - 2 : s));
    setRound((r) => r + 1);
    setCalledIdx(null);
    // Here you would emit socket event to backend
    // socket.emit('tapPlayer', { gameId, targetPlayer: animals[idx] }, (result) => { ... });
  };

  return (
    <div className="gameboard">
      <Timer timer={timer} />
      <h2>Round {round}</h2>
      <div className="circle">
        {animals.map((animal, idx) =>
          idx === centerIdx ? (
            <div key={animal} className="player center">
              <span className="animal">{animal}</span>
              <span className="score">{score} pts</span>
              <div>
                <span>Select a player to call:</span>
                {animals.map((a, i) =>
                  i !== centerIdx ? (
                    <button
                      key={i}
                      className="button"
                      onClick={() => callAnimal(i)}
                      disabled={calledIdx !== null}
                    >
                      ?
                    </button>
                  ) : null
                )}
              </div>
            </div>
          ) : (
            <div
              key={animal}
              className={`player${calledIdx === idx ? ' called' : ''}`}
              onClick={() => calledIdx === idx && handleTap(idx)}
              onTouchEnd={() => calledIdx === idx && handleTap(idx)}
            >
              <span className="animal hidden">?</span>
            </div>
          )
        )}
      </div>
      <button className="boost-btn" onClick={() => setShowBoost(true)}>
        Buy 5 Points Boost ($0.99)
      </button>
      {showBoost && <StripeBoost playerName={playerName} close={() => setShowBoost(false)} />}
      <AnimalSelector animals={animals} setAnimals={setAnimals} />
    </div>
  );
}

export default GameBoard;
