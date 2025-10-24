import express from "express";
import http from "http";
import { Server as IOServer } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import path from "path";
import fs from "fs";

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new IOServer(server, {
  cors: { origin: "*", methods: ["GET","POST"] }
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ---------- Static (optional; keeps API alive without it) ---------- */
const PUBLIC_DIR = path.join(process.cwd(), "public");
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  console.log("[BOOT] Serving static from:", PUBLIC_DIR);
} else {
  console.warn("[BOOT] public/ not found. Frontend may be deployed separately.");
}

app.get("/healthz", (_req, res) => res.json({ ok: true }));

/* ---------- Lightweight leaderboard/history ---------- */
const LEADERBOARD = [];
const HISTORY = [];
app.get("/api/leaderboard", (_req, res) => {
  const out = LEADERBOARD
    .sort((a,b)=>(b.wins||0)-(a.wins||0)||(b.best||0)-(a.best||0))
    .slice(0,100);
  res.json({ ok:true, data: out });
});
app.post("/api/leaderboard", (req,res)=>{
  const { label, city="", state="", win=false, best=0 } = req.body||{};
  if(!label) return res.status(400).json({ ok:false, error:"label required" });
  let row = LEADERBOARD.find(r=>r.label===label&&r.city===city&&r.state===state);
  if(!row){ row={label,city,state,wins:0,best:0,updatedAt:Date.now()}; LEADERBOARD.push(row); }
  if(win) row.wins++;
  row.best = Math.max(row.best, best||0);
  row.updatedAt = Date.now();
  res.json({ ok:true, row });
});
app.get("/api/history", (_req,res)=> res.json({ ok:true, data: HISTORY.slice(-200).reverse() }));
app.post("/api/history", (req,res)=>{ HISTORY.push({ ...(req.body||{}), ts:Date.now() }); res.json({ ok:true }); });

/* ---------- ElevenLabs proxy (optional) ---------- */
const XI_API_KEY   = process.env.ELEVENLABS_API_KEY   || "";
const VOICE_CALLER = process.env.ELEVENLABS_VOICE_CALLER || "";
const VOICE_TARGET = process.env.ELEVENLABS_VOICE_TARGET || "";

app.post("/api/tts", async (req,res)=>{
  try{
    if(!XI_API_KEY) return res.status(500).json({ ok:false, error:"Missing ELEVENLABS_API_KEY" });
    const { text="", role="caller" } = req.body||{};
    const voice = role==="target" ? VOICE_TARGET : VOICE_CALLER;
    if(!voice) return res.status(500).json({ ok:false, error:"Missing voice id(s)" });

    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
      method: "POST",
      headers: { "xi-api-key": XI_API_KEY, "content-type":"application/json", accept:"audio/mpeg" },
      body: JSON.stringify({ text, model_id:"eleven_monolingual_v1", voice_settings:{ stability:0.5, similarity_boost:0.8 } })
    });
    if(!r.ok){ return res.status(500).json({ ok:false, error: await r.text() }); }
    res.setHeader("Content-Type","audio/mpeg");
    r.body.pipe(res);
  }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});

/* ---------- Rooms & game state ---------- */
const rooms = new Map();
const ANIMALS = [
  "Aardvark","Alpaca","Antelope","Badger","Bat","Bear","Beaver","Bison","Boar","Buffalo","Camel","Caracal","Cat",
  "Cheetah","Cougar","Coyote","Crane","Crocodile","Crow","Deer","Dog","Donkey","Dolphin","Duck","Eagle","Elephant",
  "Elk","Emu","Falcon","Ferret","Flamingo","Fox","Gazelle","Giraffe","Goat","Gorilla","Hamster","Hare","Hawk",
  "Hedgehog","Hippo","Horse","Hyena","Ibis","Iguana","Jackal","Jaguar","Kangaroo","Koala","Lemur","Leopard","Lion",
  "Llama","Lynx","Mole","Monkey","Moose","Mouse","Ox","Otter","Owl","Panda","Panther","Parrot","Penguin","Pig",
  "Pigeon","Polar Bear","Puma","Quail","Rabbit","Raccoon","Rat","Raven","Rhino","Seal","Shark","Sheep","Skunk",
  "Sloth","Snake","Swan","Tiger","Turtle","Walrus","Wolf","Zebra"
];

function uniqueAnimal(used){
  const pool = ANIMALS.filter(a=>!used.has(a));
  return pool[Math.floor(Math.random()*pool.length)] || `Animal${used.size+1}`;
}

function makeRoom(code, theme="jungle", hostId){
  return {
    code, theme, hostId,
    players: [],             // order = ring placement
    centerIndex: 0,
    currentTargetId: null,
    roundEndsAt: 0,
    timerHandle: null,
    status: "draw",          // draw | live
    picks: new Map(),        // socketId -> 1..20
    hidden: null,
    startedAt: null
  };
}

function broadcast(room){
  io.to(room.code).emit("state:update", {
    players: room.players.map(p=>({...p})),
    centerIndex: room.centerIndex,
    currentTargetId: room.currentTargetId,
    roundEndsAt: room.roundEndsAt
  });
}

function clearRound(room){
  if(room.timerHandle){ clearTimeout(room.timerHandle); room.timerHandle=null; }
  room.currentTargetId = null;
  room.roundEndsAt = 0;
}

function startTargetTimer(room, targetId, ms=10000){
  clearRound(room);
  room.currentTargetId = targetId;
  room.roundEndsAt = Date.now()+ms;
  room.timerHandle = setTimeout(()=> onTimeout(room), ms+40);
  io.to(room.code).emit("call:started", {
    fromId: room.players[room.centerIndex]?.id,
    toId: targetId,
    endsAt: room.roundEndsAt
  });
  broadcast(room);
}

function onTimeout(room){
  if(!room.currentTargetId) return;
  const c = room.players[room.centerIndex];
  const tIndex = room.players.findIndex(p=>p.id===room.currentTargetId);
  if(tIndex===-1) return clearRound(room);
  const t = room.players[tIndex];

  // damage failing target
  t.health = Math.max(0, (t.health||20)-2);
  const died = t.health<=0;

  // ALWAYS SWAP on failure:
  // 1) swap animals
  [c.animal, t.animal] = [t.animal, c.animal];
  // 2) swap positions in list (caller goes to target's slot; target goes to middle)
  [room.players[room.centerIndex], room.players[tIndex]] = [room.players[tIndex], room.players[room.centerIndex]];

  // after swap, middle is the failing target (now at centerIndex)
  if(died){
    room.players.splice(room.centerIndex,1);
    if(room.centerIndex >= room.players.length) room.centerIndex = 0;
  }

  clearRound(room);
  io.to(room.code).emit("call:timeout", { died, centerId: room.players[room.centerIndex]?.id||null });
  broadcast(room);
}

/* ---------- Socket.IO ---------- */
io.on("connection", (socket)=>{
  socket.on("room:create", ({ theme="jungle" }={}, cb)=>{
    const code = Math.random().toString(36).slice(2,7).toUpperCase();
    rooms.set(code, makeRoom(code, theme, socket.id));
    cb?.({ ok:true, code, theme, host:true });
  });

  socket.on("room:join", ({ code, name="Player", lastInitial="", city="", state="" }={}, cb)=>{
    const room=rooms.get(code); if(!room) return cb?.({ ok:false, error:"Room not found" });
    const label = lastInitial ? `${name} ${lastInitial}.` : name;
    const used = new Set(room.players.map(p=>p.animal));
    if(!used.has("Aardvark")) used.add("Aardvark"); // keep Aardvark for the starter
    const animal = uniqueAnimal(used);
    const p = { id:socket.id, label, city, state, animal, health:20, isBot:false };
    room.players.push(p);
    socket.join(code);
    cb?.({ ok:true, code, host:room.hostId===socket.id, theme:room.theme, status:room.status, players:room.players, picks:Object.fromEntries(room.picks) });
    io.to(code).emit("room:update", { players:room.players, status:room.status, theme:room.theme, hostId:room.hostId, picks:Object.fromEntries(room.picks) });
  });

  /* draw phase */
  socket.on("draw:pick", ({ code, number }, cb)=>{
    const room=rooms.get(code); if(!room) return cb?.({ ok:false, error:"Room not found" });
    if(room.status!=="draw") return cb?.({ ok:false, error:"Not in draw phase" });
    const n=parseInt(number,10); if(!(n>=1&&n<=20)) return cb?.({ ok:false, error:"Pick 1–20" });
    if([...room.picks.values()].includes(n)) return cb?.({ ok:false, error:"Taken" });
    room.picks.set(socket.id, n);
    io.to(code).emit("room:update", { players:room.players, status:room.status, theme:room.theme, picks:Object.fromEntries(room.picks) });
    cb?.({ ok:true });
  });

  socket.on("draw:start", ({ code }, cb)=>{
    const room=rooms.get(code); if(!room) return cb?.({ ok:false, error:"Room not found" });
    if(room.hostId!==socket.id) return cb?.({ ok:false, error:"Only host" });
    if(room.status!=="draw") return cb?.({ ok:false, error:"Already live" });

    room.hidden = Math.floor(Math.random()*20)+1;
    const arr=[...room.picks.entries()].map(([id,val])=>({ id, val, d:Math.abs(val-room.hidden) }));
    if(!arr.length) return cb?.({ ok:false, error:"No picks yet" });
    arr.sort((a,b)=>a.d-b.d||a.id.localeCompare(b.id));
    const starterId = arr[0].id;

    const sidx = room.players.findIndex(p=>p.id===starterId);
    room.centerIndex = sidx!==-1 ? sidx : 0;
    if(room.players[room.centerIndex]) room.players[room.centerIndex].animal = "Aardvark";

    room.status="live"; room.startedAt=Date.now();
    clearRound(room);
    io.to(code).emit("draw:result", { hidden:room.hidden, starterId });
    io.to(code).emit("room:live", { starterId, players:room.players, theme:room.theme, startedAt:room.startedAt });
    broadcast(room);
    cb?.({ ok:true });
  });

  /* quick match */
  socket.on("match:quick", ({ name="Player", lastInitial="" }={}, cb)=>{
    let code=null;
    for(const [c,r] of rooms){ if(r.status==="draw" && c.startsWith("PUB")){ code=c; break; } }
    if(!code){ code=`PUB${Math.random().toString(36).slice(2,5).toUpperCase()}`; rooms.set(code, makeRoom(code,"jungle",socket.id)); }
    const room=rooms.get(code);
    const label=lastInitial?`${name} ${lastInitial}.`:name;
    const used=new Set(room.players.map(p=>p.animal));
    if(!used.has("Aardvark")) used.add("Aardvark");
    const animal=uniqueAnimal(used);
    room.players.push({ id:socket.id, label, city:"", state:"", animal, health:20, isBot:false });
    socket.join(code);

    if(room.players.length===1){
      room.centerIndex=0; room.players[0].animal="Aardvark"; room.status="live"; room.startedAt=Date.now();
      io.to(code).emit("room:live",{ starterId:room.players[0].id, players:room.players, theme:room.theme, startedAt:room.startedAt });
      broadcast(room);
    } else {
      io.to(code).emit("room:update",{ players:room.players, status:room.status, theme:room.theme, picks:Object.fromEntries(room.picks) });
    }
    cb?.({ ok:true, code, theme:room.theme, status:room.status, players:room.players, host:room.hostId===socket.id });
  });

  /* calls */
  socket.on("call:start", ({ code, toAnimal }, cb)=>{
    const room=rooms.get(code); if(!room) return cb?.({ ok:false, error:"Room not found" });
    if(room.status!=="live") return cb?.({ ok:false, error:"Match not live" });

    const center=room.players[room.centerIndex];
    if(!center || center.id!==socket.id) return cb?.({ ok:false, error:"Only middle may start" });

    const to = String(toAnimal||"").trim().toLowerCase();
    const target = room.players.find(p=>p.animal.toLowerCase()===to);
    if(!target || target.id===center.id) return cb?.({ ok:false, error:"Invalid target" });

    startTargetTimer(room, target.id, 10000);
    cb?.({ ok:true, toId: target.id, endsAt: room.roundEndsAt });
  });

  socket.on("call:respond", ({ code, toAnimal }, cb)=>{
    const room=rooms.get(code); if(!room) return cb?.({ ok:false, error:"Room not found" });
    if(room.status!=="live") return cb?.({ ok:false, error:"Match not live" });
    if(socket.id!==room.currentTargetId) return cb?.({ ok:false, error:"Not your turn" });
    if(Date.now()>room.roundEndsAt) return cb?.({ ok:false, error:"Too late" });

    const to = String(toAnimal||"").trim().toLowerCase();
    const next = room.players.find(p=>p.animal.toLowerCase()===to);
    if(!next || next.id===room.currentTargetId) return cb?.({ ok:false, error:"Invalid next target" });

    startTargetTimer(room, next.id, 10000);
    io.to(room.code).emit("call:progress", {
      fromId: socket.id,
      toId: next.id,
      endsAt: room.roundEndsAt
    });
    cb?.({ ok:true, toId: next.id, endsAt: room.roundEndsAt });
  });

  socket.on("disconnect", ()=>{
    for(const [code, room] of rooms){
      const idx = room.players.findIndex(p=>p.id===socket.id);
      if(idx!==-1){
        room.players.splice(idx,1);
        if(idx===room.centerIndex){ clearRound(room); if(room.centerIndex>=room.players.length) room.centerIndex=0; }
        else if(idx<room.centerIndex){ room.centerIndex--; }
        if(!room.players.length){ rooms.delete(code); }
        else broadcast(room);
      }
      room.picks.delete(socket.id);
    }
  });
});

/* ---------- SPA fallback ---------- */
app.get("*", (_req,res)=>{
  if (fs.existsSync(PUBLIC_DIR)) res.sendFile(path.join(PUBLIC_DIR,"index.html"));
  else res.status(200).send(`<!doctype html><meta charset="utf-8"><title>Survive API</title>
  <style>body{font-family:system-ui;margin:40px}</style>
  <h2>Survive API is running ✅</h2>
  <p>Deploy the frontend separately, or add a <code>public/</code> folder here.</p>`);
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, ()=> console.log(`Survive server listening on :${PORT}`));
