import React, { useEffect, useState } from 'react';
import './styles.css';

function Timer({ timer }) {
  const [timeLeft, setTimeLeft] = useState(timer);

  useEffect(() => {
    if (timeLeft <= 0) return;
    const interval = setInterval(() => setTimeLeft((t) => t - 1), 1000);
    return () => clearInterval(interval);
  }, [timeLeft]);

  const minutes = Math.floor(timeLeft / 60);
  const seconds = timeLeft % 60;

  return (
    <div className="timer">
      Timer: {minutes}:{seconds < 10 ? '0' : ''}{seconds}
    </div>
  );
}

export default Timer;
