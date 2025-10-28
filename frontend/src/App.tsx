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

const ANIMAL_EMOJI_FALLBACK: Record<string,string> = {
  aardvark:"🦬", badger:"🦡", cheetah:"🐆", dolphin:"🐬", eagle:"🦅", ferret:"🦦", gorilla:"🦍",
  hyena:"🦬", iguana:"🦎", jaguar:"🐆", koala:"🐨", lemur:"🐒", moose:"🫎", narwhal:"🐋",
  otter:"🦦", panda:"🐼", quokka:"🫎", raccoon:"🦝", sloth:"🦥", tiger:"🐯", urial:"🐏",
  vulture:"🦅", walrus:"🦭", xerus:"🐿️", yak:"🐃", zebra:"🦓", bison:"🦬", caracal:"🐈",
  duck:"🦆", emu:"🦤", fennec:"🦊", gecko:"🦎", hedgehog:"🦔", impala:"🦌", kangaroo:"🦘",
  llama:"🦙", marten:"🦦", newt:"🦎", ocelot:"🐈", platypus:"🦫", quail:"🐦", raven:"🐦",
  seal:"🦭", tapir:"🐗", uakari:"🐒", viper:"🐍", wombat:"🦥", "x-ray tetra":"🐟", yakut:"🐃", zebu:"🐂"
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
      return;
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
      const targetId =
