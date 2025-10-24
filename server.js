import express from "express";
import http from "http";
import { Server as IOServer } from "socket.io";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new IOServer(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- Static (Frontend) ----------
app.use(express.static(path.join(__dirname, "public")));

// ---------- Leaderboards / History (in-memory MVP; swap to DB in prod) ----------
const LEADERBOARD = []; // { label, city, state, wins, best, updatedAt }
const HISTORY = [];     // { ts, mode, winner, youHealth, duration }

app.get("/api/leaderboard", (req, res) => {
  res.json({
    ok: true,
    data: LEADERBOARD.sort(
      (a, b) => (b.wins || 0) - (a.wins || 0) || (b.best || 0) - (a.best || 0)
    ).slice(0, 100)
  });
});

app.post("/api/leaderboard", (req, res) => {
  const { label, city = "", state = "", win = false, best = 0 } = req.body || {};
  if (!label) return res.status(400).json({ ok: false, error: "label required" });
  let row = LEADERBOARD.find(
    (r) => r.label === label && r.city === city && r.state === state
  );
  if (!row) {
    row = { label, city, state, wins: 0, best: 0, updatedAt: Date.now() };
    LEADERBOARD.push(row);
  }
  if (win) row.wins += 1;
  row.best = Math.max(row.best || 0, best || 0);
  row.updatedAt = Date.now();
  res.json({ ok: true, row });
});

app.get("/api/history", (req, res) => {
  res.json({ ok: true, data: HISTORY.slice(-200).reverse() });
});
app.post("/api/history", (req, res) => {
  const { ts = Date.now(), mode = "Practice", winner = "", youHealth = 0, duration = "" } = req.body || {};
  HISTORY.push({ ts, mode, winner, youHealth, duration });
  res.json({ ok: true });
});

// ---------- ElevenLabs TTS proxy ----------
const XI_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const VOICE_CALLER = process.env.ELEVENLABS_VOICE_CALLER || ""; // caller voice ID
const VOICE_TARGET = process.env.ELEVENLABS_VOICE_TARGET || ""; // target voice ID

app.post("/api/tts", async (req, res) => {
  try {
    if (!XI_API_KEY) return res.status(500).json({ ok: false, error: "Missing ELEVENLABS_API_KEY" });
    const { text = "", role = "caller" } = req.body || {};
    if (!text) return res.status(400).json({ ok: false, error: "Missing text" });

    const voiceId = role === "target" ? VOICE_TARGET : VOICE_CALLER;
    if (!voiceId) return res.status(500).json({ ok: false, error: "Missing voice ID(s)" });

    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": XI_API_KEY,
        "Content-Type": "application/json",
        "accept": "audio/mpeg"
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_monolingual_v1",
        voice_settings: { stability: 0.5, similarity_boost: 0.8 }
      })
    });

    if (!r.ok) {
      const errText = await r.text();
      return res.status(500).json({ ok: false, error: `TTS failed: ${errText}` });
    }

    res.setHeader("Content-Type", "audio/mpeg");
    r.body.pipe(res);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- Socket.IO game skeleton ----------
const rooms = new Map(); // code -> { players: Map, picks:Set, hidden:number, status:'draw'|'live', theme }

const ANIMALS = [
  "Aardvark","Alpaca","Antelope","Badger","Bat","Bear","Beaver","Bison","Boar","Buffalo","Camel","Caracal","Cat","Cheetah","Cougar","Coyote","Crane","Crocodile","Crow","Deer","Dog","Donkey",
  "Dolphin","Duck","Eagle","Elephant","Elk","Emu","Falcon","Ferret","Flamingo","Fox","Gazelle","Giraffe","Goat","Gorilla","Hamster","Hare","Hawk","Hedgehog","Hippo","Horse","Hyena","Ibis",
  "Iguana","Jackal","Jaguar","Kangaroo","Koala","Lemur","Leopard","Lion","Llama","Lynx","Mole","Monkey","Moose","Mouse","Ox","Otter","Owl","Panda","Panther","Parrot","Penguin","Pig",
  "Pigeon","Polar Bear","Puma","Quail","Rabbit","Raccoon","Rat","Raven","Rhino","Seal","Shark","Sheep","Skunk","Sloth","Snake","Swan","Tiger","Turtle","Walrus","Wolf","Zebra"
];

io.on("connection", (socket) => {
  // Create room
  socket.on("room:create", ({ theme = "jungle" } = {}, cb) => {
    const code = Math.random().toString(36).slice(2, 7).toUpperCase();
    rooms.set(code, { theme, players: new Map(), picks: new Map(), hidden: null, status: "draw" });
    cb?.({ ok: true, code, theme });
  });

  // Join room
  socket.on("room:join", ({ code, name = "Player", lastInitial = "", city = "", state = "" } = {}, cb) => {
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "Room not found" });

    const label = lastInitial ? `${name} ${lastInitial}.` : name;
    // Assign a unique animal (Aardvark reserved for starter later)
    const usedAnimals = new Set([...room.players.values()].map(p => p.animal));
    let animal = "Aardvark";
    if (usedAnimals.has("Aardvark")) {
      const pool = ANIMALS.filter((a) => !usedAnimals.has(a));
      animal = pool[Math.floor(Math.random() * pool.length)] || `Animal${room.players.size + 1}`;
    }
    room.players.set(socket.id, {
      id: socket.id, label, name, city, state, animal, hp: 20, isBot: false, lastPauseAt: 0
    });
    socket.join(code);
    cb?.({ ok: true, code, player: room.players.get(socket.id), status: room.status, theme: room.theme });
    io.to(code).emit("room:update", { players: [...room.players.values()], status: room.status, theme: room.theme, picks: Object.fromEntries(room.picks) });
  });

  // Number pick (1..20 unique)
  socket.on("draw:pick", ({ code, number }, cb) => {
    const room = rooms.get(code); if(!room) return;
    if(room.status !== "draw") return cb?.({ ok:false, error:"Not in draw phase" });
    const n = parseInt(number, 10);
    if(!(n>=1 && n<=20)) return cb?.({ ok:false, error:"Pick 1-20" });
    if([...room.picks.values()].includes(n)) return cb?.({ ok:false, error:"Number already taken" });
    room.picks.set(socket.id, n);
    io.to(code).emit("room:update", { players: [...room.players.values()], status: room.status, theme: room.theme, picks: Object.fromEntries(room.picks) });
    cb?.({ ok:true });
  });

  // Start round after picks are in (host calls this)
  socket.on("draw:start", ({ code }, cb) => {
    const room = rooms.get(code); if(!room) return;
    if(room.status !== "draw") return cb?.({ ok:false, error:"Already started" });
    // roll hidden number
    const hidden = Math.floor(Math.random() * 20) + 1;
    room.hidden = hidden;
    // choose closest; make them Aardvark and caller
    const entries = [...room.picks.entries()].map(([id,val]) => ({ id, val, dist: Math.abs(val - hidden) }));
    if(entries.length === 0) return cb?.({ ok:false, error:"No picks yet" });
    entries.sort((a,b)=> a.dist - b.dist || a.id.localeCompare(b.id));
    const starterId = entries[0].id;

    // set starter as Aardvark animal explicitly
    for (const p of room.players.values()) {
      if (p.id === starterId) p.animal = "Aardvark";
    }
    room.status = "live";

    io.to(code).emit("draw:result", { hidden, starterId });
    io.to(code).emit("room:live", { starterId, players: [...room.players.values()] });
    cb?.({ ok:true, hidden, starterId });
  });

  // Broadcast typed call (e.g., "Aardvark calls Bear!")
  socket.on("call:phrase", ({ code, fromAnimal, toAnimal }, cb) => {
    const room = rooms.get(code); if(!room) return;
    io.to(code).emit("call:phrase", { fromAnimal, toAnimal, ts: Date.now() });
    cb?.({ ok:true });
  });

  socket.on("disconnect", () => {
    for (const [code, room] of rooms) {
      if (room.players.delete(socket.id)) {
        room.picks.delete(socket.id);
        io.to(code).emit("room:update", { players: [...room.players.values()], status: room.status, theme: room.theme, picks: Object.fromEntries(room.picks) });
      }
    }
  });
});

// ---------- Fallback to SPA index ----------
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Survive server running on http://localhost:${PORT}`);
});
