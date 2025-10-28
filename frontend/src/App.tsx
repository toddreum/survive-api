import React, { useEffect, useMemo, useRef, useState } from "react";
import logoUrl from "/logo.png";

type GameMode = "local" | "bots" | "online" | "friends";

const SUGGESTED_ANIMALS = [
  "Aardvark","Badger","Cheetah","Dolphin","Eagle","Ferret","Gorilla","Hyena","Iguana","Jaguar",
  "Koala","Lemur","Moose","Narwhal","Otter","Panda","Quokka","Raccoon","Sloth","Tiger",
  "Urial","Vulture","Walrus","Xerus","Yak","Zebra","Bison","Caracal","Duck","Emu",
  "Fennec","Gecko","Hedgehog","Impala","Kangaroo","Llama","Marten","Newt","Ocelot","Platypus",
  "Quail","Raven","Seal","Tapir","Uakari","Viper","Wombat","X-ray Tetra","Yakut","Zebu"
];

// Emoji fallbacks (keys are slug-form)
const ANIMAL_EMOJI_FALLBACK: Record<string,string> = {
  "aardvark":"🦬","badger":"🦡","cheetah":"🐆","dolphin":"🐬","eagle":"🦅","ferret":"🦦","gorilla":"🦍",
  "hyena":"🦬","iguana":"🦎","jaguar":"🐆","koala":"🐨","lemur":"🐒","moose":"🫎","narwhal":"🐋",
  "otter":"🦦","panda":"🐼","quokka":"🫎","raccoon":"🦝","sloth":"🦥","tiger":"🐯","urial":"🐏",
  "vulture":"🦅","walrus":"🦭","xerus":"🐿️","yak":"🐃","zebra":"🦓","bison":"🦬","caracal":"🐈",
  "duck":"🦆","emu":"🦤","fennec":"🦊","gecko":"🦎","hedgehog":"🦔","impala":"🦌","kangaroo":"🦘",
  "llama":"🦙","marten":"🦦","newt":"🦎","ocelot":"🐈","platypus":"🦫","quail":"🐦","raven":"🐦",
  "seal":"🦭","tapir":"🐗","uakari":"🐒","viper":"🐍","wombat":"🦥","x-ray-tetra":"🐟","yakut":"🐃","zebu":"🐂"
};

const neon = () => `hsl(${Math.floor(Math.random()*360)} 90% 55%)`;

function useSFX() {
  const ctxRef = useRef<AudioContext | null>(null);
  const ensure = () => {
    if (!ctxRef.current) ctxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    return ctxRef.current!;
  };
  const beep = (freq=880, dur=0.08) => {
    const ctx = ensure();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "square";
    o.frequency.value = freq;
    g.gain.value = 0.03;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + dur);
  };
  const blip = () => beep(1320, 0.06);
  const buzz = () => beep(180, 0.2);
  const win = () => { beep(880,0.1); setTimeout(()=>beep(1320,0.1),120); setTimeout(()=>beep(1760,0.12),250); };
  return { beep, blip, buzz, win };
}

type Player = {
  id: string;
  name: string;
  animal: string;
  points: number;
  seat: number;
  isBot?: boolean;
};

type Phase = "lobby" | "guess" | "animals" | "ready" | "play" | "over";

const uid = () => Math.random().toString(36).slice(2,9);
const clamp = (n:number, a:number, b:number) => Math.max(a, Math.min(b, n));

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const animalImageUrl = (animal: string) => `/animals/${slug(animal || "placeholder")}.png`;

export function closestToSecret(
  players: {id:string}[],
  guesses: Record<string, number>,
  secret: number
): string | undefined {
  if (!players.length) return undefined;
  let bestId = players[0].id; let bestDiff = Infinity;
  for (const p of players) {
    const g = guesses[p.id];
    const v = typeof g === "number" && g>=1 && g<=20 ? g : 1;
    const d = Math.abs(v - secret);
    if (d < bestDiff) { bestDiff = d; bestId = p.id; }
  }
  return bestId;
}

export function swapOnTimeout(
  players: Player[],
  failingId: string,
  centerId: string
): Player[] {
  const a = players.find(p=>p.id===failingId);
  const b = players.find(p=>p.id===centerId);
  if (!a || !b) return players;
  const aAnimal = a.animal; const bAnimal = b.animal;
  return players.map(p =>
    p.id===failingId ? { ...p, animal: bAnimal, points: clamp(p.points-5, 0, 999) } :
    p.id===centerId ? { ...p, animal: aAnimal } : p
  );
}

export function botPickTarget(players: Player[], callerId: string): string | undefined {
  const others = players.filter(p=> p.id!==callerId);
  if (!others.length) return undefined;
  const sorted = [...others].sort((a,b)=> b.points - a.points || a.name.localeCompare(b.name));
  return (sorted[0] ?? others[Math.floor(Math.random()*others.length)]).id;
}

export function canBuyBoost(boosted: Record<string, boolean>, playerId: string): boolean {
  return !boosted[playerId];
}

export default function App() {
  const [hue, setHue] = useState(200);
  useEffect(()=>{
    const t = setInterval(()=> setHue(h=> (h+1)%360 ), 30);
    return ()=> clearInterval(t);
  },[]);

  const { beep, blip, buzz, win } = useSFX();

  const [phase, setPhase] = useState<Phase>("lobby");
  const [mode, setMode] = useState<GameMode>("local");
  const [gameMinutes, setGameMinutes] = useState<2|5|10>(5);
  const [players, setPlayers] = useState<Player[]>([]);
  const [centerId, setCenterId] = useState<string|undefined>(undefined);
  const [currentTurnId, setCurrentTurnId] = useState<string|undefined>(undefined);
  const [secretTarget, setSecretTarget] = useState<number|undefined>(undefined);
  const [guesses, setGuesses] = useState<Record<string, number>>({});
  const [overallSecondsLeft, setOverallSecondsLeft] = useState<number>(0);
  const [perTurnLeft, setPerTurnLeft] = useState<number>(10);
  const [callHistory, setCallHistory] = useState<string[]>([]);
  const [paused, setPaused] = useState<boolean>(false);
  const [boostBought, setBoostBought] = useState<Record<string, boolean>>({});
  const [isTiebreaker, setIsTiebreaker] = useState<boolean>(false);

  const center = useMemo(()=> players.find(p=>p.id===centerId), [players, centerId]);
  const current = useMemo(()=> players.find(p=>p.id===currentTurnId), [players, currentTurnId]);
  const animalsTaken = useMemo(()=> new Set(players.map(p=>p.animal.toLowerCase())), [players]);

  useEffect(()=>{
    if (phase !== "play" || paused) return;
    if (overallSecondsLeft <= 0) return;
    const t = setInterval(()=> setOverallSecondsLeft(s=> s-1), 1000);
    return ()=> clearInterval(t);
  }, [phase, overallSecondsLeft, paused]);

  useEffect(()=>{
    if (phase !== "play") return;
    if (overallSecondsLeft > 0) return;

    const max = Math.max(...players.map(p=>p.points));
    theTiebreaker: {
      const tied = players.filter(p=>p.points===max);
      if (tied.length > 1) {
        setPlayers(prev => prev.filter(p => tied.some(t => t.id === p.id)));
        setIsTiebreaker(true);
        setSecretTarget(undefined);
        setGuesses({});
        setCenterId(tied[0].id);
        setCurrentTurnId(tied[0].id);
        setPerTurnLeft(10);
        setOverallSecondsLeft(60);
        setPhase("play");
        setPaused(false);
        setCallHistory(h => [`⚡ Tie-breaker begins with ${tied.length} players!`, ...h].slice(0, 12));
        beep(1200, .12);
        break theTiebreaker;
      }
    }

    win();
    setPhase("over");
    setPaused(false);
  }, [overallSecondsLeft, phase, players]);

  useEffect(()=>{
    if (phase !== "play" || paused) return;
    if (!currentTurnId) return;
    if (perTurnLeft <= 0) return;
    const t = setInterval(()=> setPerTurnLeft(s=> s-1), 1000);
    return ()=> clearInterval(t);
  }, [phase, currentTurnId, perTurnLeft, paused]);

  useEffect(()=>{
    if (phase !== "play" || paused) return;
    if (!currentTurnId) return;
    if (perTurnLeft > 0) return;
    handleFailTimeout();
  }, [perTurnLeft, phase, currentTurnId, paused]);

  useEffect(()=>{
    if (phase !== "play" || paused) return;
    if (!current || !current.isBot) return;
    const ms = 1500 + Math.random()*2000;
    const willAct = Math.random() < 0.85;
    const timer = setTimeout(()=>{
      if (!willAct) return;
      const targetId = botPickTarget(players, current.id);
      if (targetId) callPlayer(current.id, targetId);
    }, ms);
    return ()=> clearTimeout(timer);
  }, [phase, current, players, paused]);

  const addPlayer = () => {
    const id = uid();
    const seat = players.length;
    const name = `Player ${players.length+1}`;
    const newP: Player = { id, name, animal: "", points: 20, seat };
    setPlayers(p=>[...p, newP]);
    blip();
  };
  const addBot = () => {
    const id = uid();
    const seat = players.length;
    const name = `Bot ${players.length+1}`;
    const pick = Array.from(SUGGESTED_ANIMALS).find(a=> !animalsTaken.has(a.toLowerCase())) || `Bot${players.length+1}`;
    const newP: Player = { id, name, animal: pick, points: 20, seat, isBot:true };
    setPlayers(p=>[...p, newP]);
    blip();
  };
  const removePlayer = (id:string) => {
    setPlayers(prev => prev.filter(p=>p.id!==id).map((p,i)=> ({...p, seat:i})));
    blip();
  };

  const canStartGuess = players.length >= 2 && players.every(p=>p.name.trim().length>0);

  const startGuessPhase = () => {
    if (!canStartGuess) return;
    setSecretTarget(1 + Math.floor(Math.random()*20));
    setGuesses({});
    setPhase("guess");
    beep(990,0.08);
  };

  const lockGuesses = () => {
    if (!secretTarget) return;
    const filled: Record<string, number> = {...guesses};
    players.forEach(p=>{
      const g = filled[p.id];
      if (!(g>=1 && g<=20)) filled[p.id] = 1 + Math.floor(Math.random()*20);
    });
    setGuesses(filled);

    const bestId = closestToSecret(players, filled, secretTarget);
    if (bestId) {
      setCenterId(bestId);
      setPlayers(ps=> ps.map(p => p.id===bestId ? {...p, animal: "Aardvark"} : p));
    }
    setPhase("animals");
  };

  const readyToPlay = players.length>=2 && players.every(p=> p.animal.trim().length>0) && new Set(players.map(p=>p.animal.toLowerCase())).size===players.length;

  const proceedReady = () => {
    if (!readyToPlay || !centerId) return;
    setPhase("ready");
    setTimeout(()=> {
      setOverallSecondsLeft(gameMinutes*60);
      setCurrentTurnId(centerId);
      setPerTurnLeft(10);
      setPhase("play");
      setPaused(false);
      setBoostBought({});
      setIsTiebreaker(false);
    }, 600);
  };

  // Center calling another player. If center calls before clock expires, center regains +5.
  const callPlayer = (fromId:string, toId:string) => {
    if (phase !== "play" || paused) return;
    if (fromId !== currentTurnId) return;
    if (toId === fromId) return;

    const caller = players.find(p=>p.id===fromId)!;
    const target = players.find(p=>p.id===toId)!;

    if (fromId === centerId && perTurnLeft > 0) {
      setPlayers(ps => ps.map(p => p.id===fromId ? {...p, points: clamp(p.points + 5, 0, 999)} : p));
    }

    setCallHistory(h=> [`${caller.animal} ▶ ${target.animal}`,...h].slice(0,12));
    setCurrentTurnId(toId);
    setPerTurnLeft(10);
  };

  // Missed the 10s: current player loses 5, goes to center, and animals swap
  const handleFailTimeout = () => {
    if (!currentTurnId || !centerId) return;
    if (currentTurnId === centerId) { setPerTurnLeft(10); return; }
    const failingId = currentTurnId;
    setPlayers(prev => swapOnTimeout(prev, failingId, centerId));
    setCenterId(failingId);
    setCurrentTurnId(failingId);
    setPerTurnLeft(10);
  };

  const resetGame = () => {
    setPhase("lobby");
    setPlayers(p=> p.map((pl,i)=> ({...pl, animal:"", points:20, seat:i})));
    setCenterId(undefined);
    setCurrentTurnId(undefined);
    setSecretTarget(undefined);
    setGuesses({});
    setOverallSecondsLeft(0);
    setPerTurnLeft(10);
    setCallHistory([]);
    setPaused(false);
    setBoostBought({});
    setIsTiebreaker(false);
  };

  const buyFivePoints = async (pid:string) => {
    if (!paused) { alert("Pause the game to buy a Health Boost."); return; }
    if (boostBought[pid]) { alert("You already bought your boost this game."); return; }
    try {
      const r = await fetch(`/api/boost/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: pid })
      });
      const data = await r.json();
      if (data?.url) {
        window.location.href = data.url;
      } else {
        alert("Checkout is not configured. Please set HEALTH_BOOST/PRICE_ID env in backend.");
      }
    } catch (e) {
      console.error(e);
      alert("Checkout error. Try again later.");
    }
  };

  const bgStyle: React.CSSProperties = {
    background: `radial-gradient(1200px 600px at 50% 105%, hsl(${hue} 90% 12%), #05050a 60%)`,
  };

  // Circle layout — everyone spaced evenly around center
  const circleSeats = useMemo(()=>{
    const R = 240; // radius of ring
    const cx = 0, cy = 0;
    return players.map((p, i) => {
      const ang = (i / players.length) * Math.PI * 2 - Math.PI/2;
      return { id:p.id, x: cx + R*Math.cos(ang), y: cy + R*Math.sin(ang) };
    });
  }, [players]);

  const displayName = (p: Player) => (phase === "play" ? "" : p.name + (p.isBot?" 🤖":""));

  return (
    <div className="min-h-screen text-white relative overflow-hidden" style={bgStyle}>
      {/* Watermark with your logo (lobby + gameplay) */}
      <div className="survive-watermark" style={{ backgroundImage: `url(${logoUrl})` }}></div>

      <div className="relative z-10 max-w-6xl mx-auto px-4 py-6 md:py-10">
        {/* Image logo only (no text logos) */}
        <header className="flex flex-col md:flex-row md:items-end gap-3 md:gap-6 mb-6 md:mb-10">
          <div className="flex-1 flex items-center gap-3">
            <img src={logoUrl} alt="SURVIVE.COM" className="h-16 md:h-24 object-contain drop-shadow" />
          </div>
          <div className="flex items-center gap-3">
            {phase==="play" && <span className="px-2 py-1 rounded-full border text-xs tracking-wide" style={{borderColor:"#6ef", boxShadow:"0 0 10px #6ef88"}}>
              {isTiebreaker ? "Tie-Breaker" : "Game"}: {Math.floor(overallSecondsLeft/60)}:{String(overallSecondsLeft%60).padStart(2,'0')}
            </span>}
            {phase==="play" && current && <span className="px-2 py-1 rounded-full border text-xs tracking-wide" style={{borderColor:"#f6a", boxShadow:"0 0 10px #f6a8"}}>
              On the clock: {current.animal}
            </span>}
            {phase==="play" && <span className="px-2 py-1 rounded-full border text-xs tracking-wide" style={{borderColor:"#fa6", boxShadow:"0 0 10px #fa688"}}>
              Shot Clock: {perTurnLeft}s
            </span>}
          </div>
        </header>

        {phase === "lobby" && (
          <div className="grid md:grid-cols-3 gap-6">
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 md:p-6">
              <h2 className="text-xl md:text-2xl font-extrabold mb-4">Players</h2>
              <div className="space-y-3">
                {players.map((p, idx)=> (
                  <div key={p.id} className="flex items-center gap-3 bg-white/5 rounded-xl p-2 border border-white/10">
                    <span className="text-sm opacity-70 w-6">{idx+1}.</span>
                    <input className="flex-1 bg-transparent outline-none border-b border-white/20 px-2 py-1" value={p.name} onChange={e=> setPlayers(ps=> ps.map(x=> x.id===p.id? {...x, name:e.target.value}: x))} />
                    <button className="px-2 py-1 text-xs bg-red-500/20 rounded-lg border border-red-500/40" onClick={()=> removePlayer(p.id)}>Remove</button>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-3 mt-4 flex-wrap">
                <button onClick={addPlayer} className="px-4 py-2 rounded-xl bg-emerald-500/20 border border-emerald-500/40 font-semibold">+ Add Player</button>
                {(mode==="bots") && <button onClick={addBot} className="px-4 py-2 rounded-xl bg-sky-500/20 border border-sky-400/40 font-semibold">+ Add Bot</button>}
                <button disabled={!canStartGuess} onClick={startGuessPhase} className={`px-4 py-2 rounded-xl border font-semibold ${canStartGuess?"bg-indigo-500/20 border-indigo-400/50":"bg-white/5 border-white/10 opacity-60"}`}>Start — Closest Guess</button>
              </div>
              <p className="text-xs opacity-70 mt-2">At least 2 players (humans and/or bots).</p>
            </div>

            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 md:p-6">
              <h2 className="text-xl md:text-2xl font-extrabold mb-4">Game Length & Mode</h2>
              <div className="grid grid-cols-3 gap-3">
                {[2,5,10].map(m => (
                  <button key={m}
                          onClick={()=> setGameMinutes(m as 2|5|10)}
                          className={`rounded-xl px-4 py-3 border ${gameMinutes===m?"bg-fuchsia-500/20 border-fuchsia-400/60":"bg-white/5 border-white/10"}`}>
                    <div className="text-2xl font-black">{m}</div>
                    <div className="text-xs opacity-75">minutes</div>
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2 mt-4">
                {[
                  {k:"local", label:"Local (Offline)"},
                  {k:"bots", label:"Vs Bots (Offline)"},
                  {k:"online", label:"Online (Mock)"},
                  {k:"friends", label:"With Friends (Mock)"},
                ].map(opt => (
                  <button key={opt.k} onClick={()=> setMode(opt.k as GameMode)} className={`rounded-xl px-3 py-2 border text-sm ${mode===opt.k?"bg-pink-500/20 border-pink-400/60":"bg-white/5 border-white/10"}`}>{opt.label}</button>
                ))}
              </div>
              <div className="mt-4 text-sm opacity-80">Everyone starts with 20 health. Miss the clock: −5. If the center calls in time: +5 back.</div>
            </div>

            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 md:p-6">
              <h2 className="text-xl md:text-2xl font-extrabold mb-4">How to Play</h2>
              <ul className="list-disc pl-5 space-y-2 text-sm opacity-85">
                <li><b>Goal:</b> don’t go to the middle. Only the center is <b>IT</b>.</li>
                <li>Everyone guesses 1–20. Closest starts center as <b>Aardvark</b>.</li>
                <li>All others pick unique animal names (no duplicates).</li>
                <li>Center calls any <i>animal</i>. The called player has <b>10s</b> to call another.</li>
                <li>Miss the 10s: <b>−5 health</b>, become center; animals swap.</li>
                <li>Center succeeds before 10s: <b>+5 health</b> back.</li>
                <li>Names are hidden during play — only animals show.</li>
                <li>Pause to buy a one-time <b>Health Boost (+5)</b> for <b>$0.99</b>.</li>
              </ul>
            </div>
          </div>
        )}

        {phase === "guess" && (
          <div className="grid md:grid-cols-2 gap-6">
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 md:p-6">
              <h2 className="text-xl md:text-2xl font-extrabold mb-4">Closest Guess — 1 to 20</h2>
              <div className="space-y-3">
                {players.map(p=> (
                  <div key={p.id} className="flex items-center gap-3 bg-white/5 rounded-xl p-2 border border-white/10">
                    <div className="w-32 text-sm opacity-80">{p.name}</div>
                    <input type="number" min={1} max={20} className="w-24 bg-black/30 rounded-lg px-3 py-2 border border-white/10"
                           value={guesses[p.id] ?? ""}
                           placeholder="1–20"
                           onChange={e=> setGuesses(g=> ({...g, [p.id]: clamp(parseInt(e.target.value||"0",10)||0,1,20)}))} />
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-3 mt-4">
                <button onClick={lockGuesses} className="px-4 py-2 rounded-xl bg-emerald-500/20 border border-emerald-500/40 font-semibold">Lock & Reveal</button>
                {secretTarget && <span className="px-2 py-1 rounded-full border text-xs tracking-wide" style={{borderColor:"#6ef"}}>Secret was {secretTarget}</span>}
              </div>
            </div>
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 md:p-6">
              <h2 className="text-xl md:text-2xl font-extrabold mb-4">What happens next?</h2>
              <p className="opacity-85">Closest becomes <b>Aardvark</b> in the middle. Everyone else picks a unique animal name next.</p>
            </div>
          </div>
        )}

        {phase === "animals" && (
          <div className="grid md:grid-cols-3 gap-6">
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 md:p-6">
              <h2 className="text-xl md:text-2xl font-extrabold mb-4">Pick Unique Animal Names</h2>
              <div className="space-y-3">
                {players.map(p=> (
                  <div key={p.id} className="flex flex-col gap-2 bg-white/5 rounded-xl p-3 border border-white/10">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg overflow-hidden bg-white/10 border border-white/20 flex items-center justify-center">
                        <img
                          src={animalImageUrl(p.animal)}
                          onError={(e)=>{ (e.currentTarget as HTMLImageElement).style.display='none'; }}
                          className="w-full h-full object-cover"
                          alt=""
                        />
                        <span className="text-lg" aria-hidden>{ANIMAL_EMOJI_FALLBACK[slug(p.animal)] || "🐾"}</span>
                      </div>
                      <div className="flex-1">
                        <div className="text-sm opacity-80">{p.name}</div>
                        <input className="w-full bg-black/30 rounded-lg px-3 py-2 border border-white/10" value={p.animal}
                               onChange={e=> setPlayers(ps=> ps.map(x=> x.id===p.id? {...x, animal: e.target.value}: x))}
                               placeholder={p.id===centerId?"Aardvark":"Pick an animal"}
                               disabled={p.id===centerId}
                        />
                      </div>
                    </div>
                    <div className="text-xs opacity-70">{p.id===centerId?"Starts in the middle":"Must be unique across all players"}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 md:p-6">
              <h2 className="text-xl md:text-2xl font-extrabold mb-4">Status</h2>
              <div className="space-y-2 text-sm">
                <div className="opacity-90">Center: <b>{players.find(p=>p.id===centerId)?.name}</b> = <b>{players.find(p=>p.id===centerId)?.animal||""}</b></div>
                <div className="opacity-80">All names must be unique. "Aardvark" is reserved for the center.</div>
                <div className="opacity-70">When ready, press <b>Arm the Arena</b>.</div>
              </div>
              <div className="mt-4">
                <button disabled={!readyToPlay} onClick={proceedReady} className={`px-4 py-3 rounded-xl border font-black tracking-wider ${readyToPlay?"bg-pink-500/20 border-pink-400/60":"bg-white/5 border-white/10 opacity-60"}`}>Arm the Arena</button>
              </div>
            </div>

            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 md:p-6">
              <h2 className="text-xl md:text-2xl font-extrabold mb-4">Scores (start at 20)</h2>
              <div className="grid grid-cols-1 gap-2">
                {players.map(p=> (
                  <div key={p.id} className="flex items-center justify-between bg-white/5 rounded-xl px-3 py-2 border border-white/10">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-md overflow-hidden bg-white/10 border border-white/20 flex items-center justify-center">
                        <img
                          src={animalImageUrl(p.animal)}
                          onError={(e)=>{ (e.currentTarget as HTMLImageElement).style.display='none'; }}
                          className="w-full h-full object-cover"
                          alt=""
                        />
                        <span className="text-base" aria-hidden>{ANIMAL_EMOJI_FALLBACK[slug(p.animal)] || "🐾"}</span>
                      </div>
                      <span className="px-2 py-1 rounded-full border text-xs" style={{borderColor:"#9ff"}}>{p.animal || "?"}</span>
                      <span className="opacity-80">{p.name}</span>
                    </div>
                    <div className="font-bold">{p.points} pts</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {phase === "ready" && (
          <div className="grid md:grid-cols-2 gap-6 items-start">
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 md:p-6 text-center">
              <div className="text-sm opacity-80 mb-2">Get ready! Round begins…</div>
              <img src={logoUrl} alt="SURVIVE.COM" className="h-32 mx-auto opacity-80" />
            </div>
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 md:p-6 text-center">
              <div className="text-6xl font-black tracking-widest">3</div>
              <div className="opacity-70">Launching play…</div>
              <button onClick={()=> setPhase("play")} className="mt-4 px-4 py-2 rounded-xl bg-emerald-500/20 border border-emerald-500/40">Skip</button>
            </div>
          </div>
        )}

        {phase === "play" && (
          <div className="grid lg:grid-cols-3 gap-6">
            {/* Arena */}
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 md:p-6">
              <h2 className="text-xl md:text-2xl font-extrabold mb-4">Arena</h2>
              <div className="relative mx-auto h-[560px]">
                {/* Center — IT */}
                <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-44 h-44 rounded-full flex flex-col items-center justify-center text-center border-4 bg-black/50" style={{
                  borderColor: `hsl(${hue} 90% 60%)`,
                  boxShadow: `0 0 30px hsl(${hue} 90% 60%)/.8, inset 0 0 20px hsl(${hue} 90% 60%)/.5`
                }}>
                  <div className="w-16 h-16 rounded-full overflow-hidden bg-white/10 border border-white/20 mb-1 flex items-center justify-center">
                    <img
                      src={animalImageUrl(center?.animal || "")}
                      onError={(e)=>{ (e.currentTarget as HTMLImageElement).style.display='none'; }}
                      className="w-full h-full object-cover"
                      alt=""
                    />
                    <span className="text-2xl" aria-hidden>{ANIMAL_EMOJI_FALLBACK[slug(center?.animal || "")] || "🐾"}</span>
                  </div>
                  <div className="text-xs opacity-80">CENTER · IT</div>
                  <div className="text-2xl font-black tracking-wider">{center?.animal}</div>
                </div>

                {/* Ring — evenly spaced seats */}
                <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" style={{width:0,height:0}}>
                  {circleSeats.map((s, idx)=> {
                    const p = players[idx];
                    if (!p) return null;
                    const glow = neon();
                    return (
                      <div key={p.id} style={{position:"absolute", transform:`translate(${s.x}px, ${s.y}px)`}}>
                        <div className={`w-28 h-28 rounded-2xl border flex flex-col items-center justify-center gap-1 ${p.id===currentTurnId?"ring-2 ring-white/70":""}`} style={{
                          borderColor: glow,
                          boxShadow:`0 0 18px ${glow}aa, inset 0 0 12px ${glow}55`
                        }}>
                          <div className="w-12 h-12 rounded-md overflow-hidden bg-white/10 border border-white/20 flex items-center justify-center">
                            <img
                              src={animalImageUrl(p.animal)}
                              onError={(e)=>{ (e.currentTarget as HTMLImageElement).style.display='none'; }}
                              className="w-full h-full object-cover"
                              alt=""
                            />
                            <span className="text-xl" aria-hidden>{ANIMAL_EMOJI_FALLBACK[slug(p.animal)] || "🐾"}</span>
                          </div>
                          <div className="text-base font-black">{p.animal}</div>
                          <div className="text-xs opacity-80">{p.points} pts</div>
                          {currentTurnId===centerId && centerId===p.id ? (
                            <div className="text-[10px] opacity-80">Call someone!</div>
                          ): currentTurnId===p.id ? (
                            <div className="text-[10px] opacity-80">Your turn!</div>
                          ): <div className="text-[10px] opacity-30">…</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {paused && (
                  <div className="absolute inset-0 backdrop-blur-sm bg-black/40 flex items-center justify-center">
                    <div className="px-6 py-4 rounded-2xl bg-white/10 border border-white/20">
                      <div className="text-lg font-bold mb-2">Paused</div>
                      <div className="text-xs opacity-80">Buy Health Boosts now (one per player), then resume.</div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Controls — call another animal */}
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 md:p-6">
              <h2 className="text-xl md:text-2xl font-extrabold mb-4">{current?.id===centerId?"Center — Call Any Animal":"Call Another Animal"}</h2>
              {current && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-sm opacity-85">Current: <b>{current.animal}</b></div>
                    <div className="text-sm opacity-85">Shot clock: <b>{perTurnLeft}s</b></div>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2 max-h-72 overflow-auto pr-1">
                    {players.filter(p=> p.id!==current.id).map(p=> (
                      <button key={p.id}
                              onClick={()=> callPlayer(current.id, p.id)}
                              className="px-3 py-3 rounded-xl bg-white/5 border border-white/10 text-left">
                        <div className="flex items-center gap-2">
                          <div className="w-8 h-8 rounded-md overflow-hidden bg-white/10 border border-white/20 flex items-center justify-center">
                            <img
                              src={animalImageUrl(p.animal)}
                              onError={(e)=>{ (e.currentTarget as HTMLImageElement).style.display='none'; }}
                              className="w-full h-full object-cover"
                              alt=""
                            />
                            <span className="text-base" aria-hidden>{ANIMAL_EMOJI_FALLBACK[slug(p.animal)] || "🐾"}</span>
                          </div>
                          <div className="text-lg font-extrabold tracking-wider">{p.animal}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Scoreboard & Boost */}
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 md:p-6">
              <h2 className="text-xl md:text-2xl font-extrabold mb-4">Scoreboard & Perks</h2>
              <div className="space-y-2">
                {players.map(p=> (
                  <div key={p.id} className={`flex items-center justify-between bg-white/5 rounded-xl px-3 py-2 border ${p.id===centerId?"border-yellow-400/40":"border-white/10"}`}>
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-md overflow-hidden bg-white/10 border border-white/20 flex items-center justify-center">
                        <img
                          src={animalImageUrl(p.animal)}
                          onError={(e)=>{ (e.currentTarget as HTMLImageElement).style.display='none'; }}
                          className="w-full h-full object-cover"
                          alt=""
                        />
                        <span className="text-base" aria-hidden>{ANIMAL_EMOJI_FALLBACK[slug(p.animal)] || "🐾"}</span>
                      </div>
                      <span className="px-2 py-1 rounded-full border text-xs" style={{borderColor: p.id===centerId?"#fe6":"#9ff"}}>{p.animal}</span>
                      <span className="opacity-85">{phase!=="play" ? displayName(p) : ""}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold w-16 text-right">{p.points} pts</span>
                      <button disabled={(phase!=="play") || !paused || boostBought[p.id]}
                              onClick={()=> buyFivePoints(p.id)}
                              className={`px-3 py-1.5 rounded-lg text-xs border ${boostBought[p.id]?"bg-green-500/20 border-green-400/50":"bg-pink-500/20 border-pink-400/50"}`}>
                        {boostBought[p.id] ? "Boosted ✓" : "Health Boost +5 ($0.99)"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex items-center gap-3 flex-wrap">
                <button onClick={()=> setPaused(p=>!p)} className="px-4 py-2 rounded-xl bg-white/10 border border-white/20">
                  {paused?"Resume":"Pause"}
                </button>
                <button onClick={resetGame} className="px-4 py-2 rounded-xl bg-red-500/20 border border-red-500/40">Reset</button>
              </div>
              <div className="mt-3 text-xs opacity-70">Stripe Checkout live via backend. One purchase per player per game.</div>
              <div className="mt-3">
                <div className="text-sm opacity-85 mb-2">Last Calls</div>
                <div className="bg-black/30 rounded-xl p-2 border border-white/10 h-28 overflow-auto">
                  {callHistory.length===0? <div className="text-xs opacity-50">No calls yet.</div> : (
                    <ul className="text-xs space-y-1">
                      {callHistory.map((h, i)=> <li key={i}>{h}</li>)}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {phase === "over" && (
          <div className="grid md:grid-cols-2 gap-6 items-start">
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 md:p-6">
              <h2 className="text-xl md:text-2xl font-extrabold mb-4">Final Scores</h2>
              <div className="space-y-2">
                {players.sort((a,b)=> b.points-a.points).map((p, i)=> (
                  <div key={p.id} className="flex items-center justify-between bg-white/5 rounded-xl px-3 py-2 border border-white/10">
                    <div className="flex items-center gap-2">
                      <span className="w-6 text-sm opacity-60">{i+1}.</span>
                      <div className="w-6 h-6 rounded overflow-hidden bg-white/10 border border-white/20 flex items-center justify-center">
                        <img
                          src={animalImageUrl(p.animal)}
                          onError={(e)=>{ (e.currentTarget as HTMLImageElement).style.display='none'; }}
                          className="w-full h-full object-cover"
                          alt=""
                        />
                        <span className="text-sm" aria-hidden>{ANIMAL_EMOJI_FALLBACK[slug(p.animal)] || "🐾"}</span>
                      </div>
                      <span className="px-2 py-1 rounded-full border text-xs" style={{borderColor:"#9ff"}}>{p.animal}</span>
                      <span className="opacity-85">{p.name}{p.isBot?" 🤖":""}</span>
                    </div>
                    <div className="font-bold">{p.points} pts</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 md:p-6">
              <h2 className="text-xl md:text-2xl font-extrabold mb-4">Winners</h2>
              <div className="text-lg">
                {(() => {
                  const max = Math.max(...players.map(p=>p.points));
                  const winners = players.filter(p=>p.points===max);
                  return winners.length>1
                    ? <div>It's a tie! <b>{winners.map(w=> w.name).join(", ")}</b> share the crown.</div>
                    : <div>Champion: <b>{winners[0]?.name}</b> the <b>{winners[0]?.animal}</b>!</div>;
                })()}
              </div>
              <div className="mt-4 flex items-center gap-3">
                <button onClick={resetGame} className="px-4 py-2 rounded-xl bg-emerald-500/20 border border-emerald-500/40">Play Again</button>
              </div>
            </div>
          </div>
        )}

        <footer className="mt-10 text-center opacity-70 text-xs">
          <div>Built for party chaos. Best played on a big screen. 🔊</div>
        </footer>
      </div>
    </div>
  );
}
