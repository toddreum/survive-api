import express from "express";
import http from "http";
import { Server as IOServer } from "socket.io";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new IOServer(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* --------- STATIC --------- */
const PUBLIC_DIR = process.env.PUBLIC_DIR
  ? path.resolve(process.env.PUBLIC_DIR)
  : path.join(__dirname, "public");

console.log("[BOOT] PUBLIC_DIR =", PUBLIC_DIR);
try { console.log("[BOOT] public contents:", fs.readdirSync(PUBLIC_DIR)); }
catch(e){ console.warn("[BOOT] public not found:", e.message); }

app.use(express.static(PUBLIC_DIR));

/* --------- Simple in-memory LB/History (swap to DB later) --------- */
const LEADERBOARD = [];
const HISTORY = [];

app.get("/api/leaderboard", (req, res) => {
  res.json({ ok:true, data: LEADERBOARD.sort((a,b)=> (b.wins||0)-(a.wins||0) || (b.best||0)-(a.best||0)).slice(0,100) });
});
app.post("/api/leaderboard", (req, res) => {
  const { label, city="", state="", win=false, best=0 } = req.body || {};
  if(!label) return res.status(400).json({ ok:false, error:"label required" });
  let row = LEADERBOARD.find(r => r.label===label && r.city===city && r.state===state);
  if(!row){ row = { label, city, state, wins:0, best:0, updatedAt:Date.now() }; LEADERBOARD.push(row); }
  if(win) row.wins += 1;
  row.best = Math.max(row.best || 0, best || 0);
  row.updatedAt = Date.now();
  res.json({ ok:true, row });
});
app.get("/api/history", (req, res) => res.json({ ok:true, data: HISTORY.slice(-200).reverse() }));
app.post("/api/history", (req, res) => { HISTORY.push({ ...(req.body||{}), ts: Date.now() }); res.json({ ok:true }); });

/* --------- ElevenLabs TTS proxy --------- */
const XI_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const VOICE_CALLER = process.env.ELEVENLABS_VOICE_CALLER || "";
const VOICE_TARGET = process.env.ELEVENLABS_VOICE_TARGET || "";

app.post("/api/tts", async (req, res) => {
  try {
    if (!XI_API_KEY) return res.status(500).json({ ok:false, error:"Missing ELEVENLABS_API_KEY" });
    const { text = "", role = "caller" } = req.body || {};
    if (!text) return res.status(400).json({ ok:false, error:"Missing text" });
    const voiceId = role === "target" ? VOICE_TARGET : VOICE_CALLER;
    if (!voiceId) return res.status(500).json({ ok:false, error:"Missing voice id(s)" });

    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: { "xi-api-key": XI_API_KEY, "Content-Type": "application/json", "accept": "audio/mpeg" },
      body: JSON.stringify({ text, model_id: "eleven_monolingual_v1", voice_settings: { stability: 0.5, similarity_boost: 0.8 } })
    });
    if(!r.ok){ const t = await r.text(); return res.status(500).json({ ok:false, error: t }); }
    res.setHeader("Content-Type","audio/mpeg");
    r.body.pipe(res);
  } catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});

/* --------- Game state --------- */
const rooms = new Map(); // code -> room

const ANIMALS = [
  "Aardvark","Alpaca","Antelope","Badger","Bat","Bear","Beaver","Bison","Boar","Buffalo","Camel",
  "Caracal","Cat","Cheetah","Cougar","Coyote","Crane","Crocodile","Crow","Deer","Dog","Donkey",
  "Dolphin","Duck","Eagle","Elephant","Elk","Emu","Falcon","Ferret","Flamingo","Fox","Gazelle",
  "Giraffe","Goat","Gorilla","Hamster","Hare","Hawk","Hedgehog","Hippo","Horse","Hyena","Ibis",
  "Iguana","Jackal","Jaguar","Kangaroo","Koala","Lemur","Leopard","Lion","Llama","Lynx","Mole",
  "Monkey","Moose","Mouse","Ox","Otter","Owl","Panda","Panther","Parrot","Penguin","Pig","Pigeon",
  "Polar Bear","Puma","Quail","Rabbit","Raccoon","Rat","Raven","Rhino","Seal","Shark","Sheep",
  "Skunk","Sloth","Snake","Swan","Tiger","Turtle","Walrus","Wolf","Zebra"
];

function uniqueAnimal(used){
  const pool = ANIMALS.filter(a => !used.has(a));
  return pool[Math.floor(Math.random()*pool.length)] || `Animal${used.size+1}`;
}

function makeRoom(code, theme="jungle", hostId){
  return {
    code, theme, hostId,
    players: [],                // ordered list -> determines ring placement
    centerIndex: 0,             // current middle index
    currentTargetId: null,      // id of player under 10s timer
    roundEndsAt: 0,             // timestamp ms
    timerHandle: null,          // Node timeout handle
    status: "draw",             // draw | live
    picks: new Map(),           // socketId -> 1..20
    hidden: null,               // hidden number result
    startedAt: null
  };
}

function broadcastState(room){
  io.to(room.code).emit("state:update", {
    players: room.players.map(p => ({ ...p })), // id,label,city,state,animal,health,isBot
    centerIndex: room.centerIndex,
    currentTargetId: room.currentTargetId,
    roundEndsAt: room.roundEndsAt
  });
}

function clearRoundTimer(room){
  if(room.timerHandle){ clearTimeout(room.timerHandle); room.timerHandle=null; }
  room.currentTargetId = null;
  room.roundEndsAt = 0;
}

function startTargetTimer(room, targetId, ms=10000){
  clearRoundTimer(room);
  room.currentTargetId = targetId;
  room.roundEndsAt = Date.now() + ms;
  // schedule timeout
  room.timerHandle = setTimeout(() => onTargetTimeout(room), ms + 50);
  io.to(room.code).emit("call:started", {
    fromId: room.players[room.centerIndex]?.id,
    toId: targetId,
    endsAt: room.roundEndsAt
  });
  broadcastState(room);
}

function onTargetTimeout(room){
  if(!room.currentTargetId) return; // already handled
  const center = room.players[room.centerIndex];
  const tIdx = room.players.findIndex(p => p.id === room.currentTargetId);
  if(tIdx === -1) { clearRoundTimer(room); broadcastState(room); return; }
  const target = room.players[tIdx];

  // Apply -2 health to failing target
  target.health = Math.max(0, (target.health||20) - 2);
  const died = target.health <= 0;

  // SWAP animals AND positions between caller(center) and failing target (ALWAYS on timeout)
  // - caller moves to target spot and assumes target's animal
  // - failing target goes to middle and assumes caller's animal
  const callerAnimal = center.animal;
  const targetAnimal = target.animal;
  center.animal = targetAnimal;
  target.animal = callerAnimal;

  // swap positions in players array
  [room.players[room.centerIndex], room.players[tIdx]] = [room.players[tIdx], room.players[room.centerIndex]];

  // after swap, centerIndex now points to the failing target (now at middle)
  // if dead, remove the middle (target) after swap and keep new middle as next player at that index
  if (died) {
    room.players.splice(room.centerIndex, 1);
    if (room.players.length === 0) {
      room.centerIndex = 0;
    } else if (room.centerIndex >= room.players.length) {
      room.centerIndex = 0;
    }
  }

  clearRoundTimer(room);

  io.to(room.code).emit("call:timeout", {
    died,
    centerId: room.players[room.centerIndex]?.id || null
  });

  broadcastState(room);
}

/* --------- Socket.IO --------- */
io.on("connection", (socket) => {
  /* Create private room */
  socket.on("room:create", ({ theme="jungle" }={}, cb) => {
    const code = Math.random().toString(36).slice(2,7).toUpperCase();
    const room = makeRoom(code, theme, socket.id);
    rooms.set(code, room);
    cb?.({ ok:true, code, theme, host:true });
  });

  /* Join room */
  socket.on("room:join", ({ code, name="Player", lastInitial="", city="", state="" }={}, cb) => {
    const room = rooms.get(code);
    if(!room) return cb?.({ ok:false, error:"Room not found" });

    const label = lastInitial ? `${name} ${lastInitial}.` : name;
    const used = new Set(room.players.map(p=>p.animal));
    // keep Aardvark free until game goes live; if not used, don't assign it here
    if (!used.has("Aardvark")) used.add("Aardvark");
    const animal = uniqueAnimal(used);

    const player = { id: socket.id, label, city, state, animal, health:20, isBot:false };
    room.players.push(player);

    socket.join(code);
    cb?.({ ok:true, code, host: room.hostId===socket.id, theme:room.theme, status:room.status, players: room.players, picks: Object.fromEntries(room.picks) });
    io.to(code).emit("room:update", { players: room.players, status: room.status, theme: room.theme, hostId: room.hostId, picks: Object.fromEntries(room.picks) });
  });

  /* Number draw */
  socket.on("draw:pick", ({ code, number }, cb) => {
    const room = rooms.get(code); if(!room) return cb?.({ ok:false, error:"Room not found" });
    if(room.status!=="draw") return cb?.({ ok:false, error:"Not in draw phase" });
    const n = parseInt(number,10);
    if(!(n>=1 && n<=20)) return cb?.({ ok:false, error:"Pick 1-20" });
    if([...room.picks.values()].includes(n)) return cb?.({ ok:false, error:"Number already taken" });
    room.picks.set(socket.id, n);
    io.to(code).emit("room:update", { players:room.players, status:room.status, theme:room.theme, hostId:room.hostId, picks:Object.fromEntries(room.picks) });
    cb?.({ ok:true });
  });

  socket.on("draw:start", ({ code }, cb) => {
    const room = rooms.get(code); if(!room) return cb?.({ ok:false, error:"Room not found" });
    if(room.hostId !== socket.id) return cb?.({ ok:false, error:"Only host can start" });
    if(room.status!=="draw") return cb?.({ ok:false, error:"Already started" });

    room.hidden = Math.floor(Math.random()*20)+1;
    const entries = [...room.picks.entries()].map(([id,val])=>({ id, val, dist:Math.abs(val-room.hidden) }));
    if(entries.length===0) return cb?.({ ok:false, error:"No picks yet" });
    entries.sort((a,b)=> a.dist - b.dist || a.id.localeCompare(b.id));
    const starterId = entries[0].id;

    // Make starter the Aardvark at center
    const sIdx = room.players.findIndex(p=>p.id===starterId);
    if(sIdx !== -1){
      room.centerIndex = sIdx;
      room.players[room.centerIndex].animal = "Aardvark";
    } else {
      room.centerIndex = 0;
      if(room.players[0]) room.players[0].animal = "Aardvark";
    }

    room.status = "live"; room.startedAt = Date.now();
    clearRoundTimer(room);

    io.to(code).emit("draw:result", { hidden:room.hidden, starterId });
    io.to(code).emit("room:live", { starterId, players: room.players, theme: room.theme, startedAt: room.startedAt });
    broadcastState(room);
    cb?.({ ok:true });
  });

  /* Quick match (public pool) */
  socket.on("match:quick", ({ name="Player", lastInitial="" }={}, cb) => {
    let code = null;
    for (const [c,room] of rooms) { if (room.status==="draw" && room.hostId && c.startsWith("PUB")) { code=c; break; } }
    if (!code) {
      code = `PUB${Math.random().toString(36).slice(2,5).toUpperCase()}`;
      rooms.set(code, makeRoom(code, "jungle", socket.id));
    }
    const room = rooms.get(code);
    const label = lastInitial ? `${name} ${lastInitial}.` : name;

    const used = new Set(room.players.map(p=>p.animal));
    if (!used.has("Aardvark")) used.add("Aardvark");
    const animal = uniqueAnimal(used);

    room.players.push({ id:socket.id, label, city:"", state:"", animal, health:20, isBot:false });
    socket.join(code);

    if (room.players.length === 1) {
      room.centerIndex = 0;
      room.players[0].animal = "Aardvark";
      room.status="live"; room.startedAt=Date.now();
      io.to(code).emit("room:live", { starterId: room.players[0].id, players: room.players, theme: room.theme, startedAt: room.startedAt });
      broadcastState(room);
    } else {
      io.to(code).emit("room:update", { players:room.players, status:room.status, theme:room.theme, hostId:room.hostId, picks:Object.fromEntries(room.picks) });
    }

    cb?.({ ok:true, code, theme:room.theme, status:room.status, players: room.players, host: room.hostId===socket.id });
  });

  /* ----- Calls: start & respond (SERVER-ENFORCED) ----- */

  // Center starts a call by selecting a target ANIMAL
  socket.on("call:start", ({ code, toAnimal }, cb) => {
    const room = rooms.get(code); if(!room) return cb?.({ ok:false, error:"Room not found" });
    if(room.status!=="live") return cb?.({ ok:false, error:"Match not live" });

    const center = room.players[room.centerIndex];
    if(!center || center.id !== socket.id) return cb?.({ ok:false, error:"Only middle may start the call" });

    const toName = String(toAnimal||"").trim().toLowerCase();
    if(!toName) return cb?.({ ok:false, error:"Missing animal" });

    const target = room.players.find(p => p.animal.toLowerCase() === toName);
    if(!target || target.id === center.id) return cb?.({ ok:false, error:"Invalid target" });

    startTargetTimer(room, target.id, 10000);
    cb?.({ ok:true, toId: target.id, endsAt: room.roundEndsAt });
  });

  // Called player responds within 10s by naming a new ANIMAL
  socket.on("call:respond", ({ code, toAnimal }, cb) => {
    const room = rooms.get(code); if(!room) return cb?.({ ok:false, error:"Room not found" });
    if(room.status!=="live") return cb?.({ ok:false, error:"Match not live" });
    if(!room.currentTargetId) return cb?.({ ok:false, error:"No active target" });
    if(socket.id !== room.currentTargetId) return cb?.({ ok:false, error:"It's not your turn" });

    if(Date.now() > room.roundEndsAt) return cb?.({ ok:false, error:"Too late" });

    const toName = String(toAnimal||"").trim().toLowerCase();
    if(!toName) return cb?.({ ok:false, error:"Missing animal" });

    const currentTarget = room.players.find(p => p.id === room.currentTargetId);
    const nextTarget = room.players.find(p => p.animal.toLowerCase() === toName);
    if(!nextTarget || nextTarget.id === currentTarget.id) return cb?.({ ok:false, error:"Invalid next target" });

    // SUCCESS: middle stays in middle; new target becomes the named animal
    startTargetTimer(room, nextTarget.id, 10000);
    io.to(room.code).emit("call:progress", {
      fromId: currentTarget.id,
      toId: nextTarget.id,
      endsAt: room.roundEndsAt
    });
    cb?.({ ok:true, toId: nextTarget.id, endsAt: room.roundEndsAt });
  });

  /* ----- Disconnect cleanup ----- */
  socket.on("disconnect", () => {
    for (const [code, room] of rooms) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        // remove player
        room.players.splice(idx,1);
        if(idx === room.centerIndex){
          // if middle left, pick next player as new middle
          room.centerIndex = Math.min(room.centerIndex, Math.max(0, room.players.length-1));
          clearRoundTimer(room);
        } else if (idx < room.centerIndex) {
          room.centerIndex -= 1;
        }
        if(room.players.length === 0){
          rooms.delete(code);
        } else {
          broadcastState(room);
        }
      }
      room.picks.delete(socket.id);
    }
  });
});

/* --------- SPA fallback --------- */
app.get("*", (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, "index.html");
  if (fs.existsSync(indexPath)) res.sendFile(indexPath);
  else res.status(200).send(`<!doctype html><meta charset="utf-8"><title>Survive API</title>
    <style>body{font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial;margin:40px;color:#0b1020}
    code{background:#f2f3f7;padding:2px 6px;border-radius:6px}</style>
    <h1>Survive API is live ✅</h1>
    <p><b>Note:</b> <code>${indexPath}</code> missing. Add <code>/public/index.html</code>.</p>`);
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Survive server running at http://localhost:${PORT}`));
