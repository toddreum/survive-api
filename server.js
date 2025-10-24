// server.js
import express from "express";
import http from "http";
import cors from "cors";
import Stripe from "stripe";
import { Server } from "socket.io";
import bodyParser from "body-parser";

const app = express();

// IMPORTANT: raw body for webhook BEFORE json parser
app.post("/webhook", bodyParser.raw({ type: "application/json" }), webhookHandler);

// General middleware
app.use(cors());
app.use(express.json());

// ----- Config -----
const PORT = process.env.PORT || 8080;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", { apiVersion: "2024-06-20" });
const PRICE_HEALTH = process.env.STRIPE_PRICE_HEALTH_BOOST; // price_xxx
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// ----- HTTP Server + Sockets -----
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*"} });

// ----- In-memory state (swap for DB later) -----
const rooms = new Map(); // code -> { players:[], used:Set, paused:false }
const leaderboard = new Map(); // key -> { name, city, wins }
const history = []; // { ts, winnerName, winnerCity, loserName, roomCode }

const ANIMALS = [
  "Aardvark","Dog","Cat","Fox","Wolf","Tiger","Lion","Leopard","Horse","Zebra",
  "Elephant","Rhino","Hippo","Monkey","Gorilla","Panda","Koala","Kangaroo","Pig","Cow",
  "Sheep","Goat","Chicken","Penguin","PolarBear","Seal","Dolphin","Whale","Eagle","Owl"
];

// Utility
function uniqueAnimal(room) {
  const used = room.used || new Set();
  const available = ANIMALS.filter(a => !used.has(a));
  const pick = available.length
    ? available[Math.floor(Math.random()*available.length)]
    : ANIMALS[Math.floor(Math.random()*ANIMALS.length)];
  used.add(pick);
  room.used = used;
  return pick;
}
function winsKey(name, city){ return `${name}__${city||""}`; }

// ----- API: Health Booster -----
app.post("/api/buy_health", async (req, res) => {
  try {
    const { roomCode, playerId } = req.body || {};
    if(!PRICE_HEALTH) return res.status(500).json({ error: "Missing STRIPE_PRICE_HEALTH_BOOST" });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: PRICE_HEALTH, quantity: 1 }],
      metadata: { type: "HEALTH_BOOST", roomCode, playerId },
      success_url: `${CLIENT_URL}?success=true`,
      cancel_url: `${CLIENT_URL}?canceled=true`,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ----- API: Leaderboard (wins) -----
app.get("/api/leaderboard", (req, res) => {
  const rows = [...leaderboard.values()].sort((a,b)=>b.wins-a.wins).slice(0,100);
  res.json(rows);
});

// ----- API: Recent history -----
app.get("/api/history", (req, res) => {
  res.json(history.slice(-100).reverse());
});

// ----- Webhook handler (must be declared above) -----
function webhookHandler(req, res) {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    if (session.metadata?.type === "HEALTH_BOOST") {
      const { roomCode, playerId } = session.metadata;
      const room = rooms.get(roomCode);
      if (room) {
        const player = room.players.find(p => p.id === playerId);
        if (player) {
          player.hp = Math.min(20, (player.hp || 20) + 2);
          io.to(roomCode).emit("playerUpdated", { id: playerId, hp: player.hp });
          io.to(roomCode).emit("gameResumed");
        }
      }
    }
  }
  res.sendStatus(200);
}

// ----- Socket events -----
io.on("connection", socket => {
  socket.on("joinRoom", ({ roomCode, firstName, lastName, city }) => {
    if(!roomCode) return;
    if(!rooms.has(roomCode)) rooms.set(roomCode, { players: [], used: new Set(), paused:false });

    const room = rooms.get(roomCode);
    const animal = uniqueAnimal(room);
    const lastInitial = (lastName||"").trim().charAt(0).toUpperCase();
    const name = `${(firstName||"Player").trim()}${lastInitial ? " "+lastInitial+"." : ""}`;

    const player = { id: socket.id, name, city, animal, hp:20, isBot:false, alive:true };
    room.players.push(player);
    socket.join(roomCode);
    io.to(roomCode).emit("playerList", room.players);
  });

  // Report a fail from the active target → server applies damage & caller reward (+2)
  socket.on("reportFail", ({ roomCode, targetId, callerId }) => {
    const room = rooms.get(roomCode); if(!room) return;
    const target = room.players.find(p=>p.id===targetId);
    const caller = room.players.find(p=>p.id===callerId);
    if(!target || !caller) return;

    target.hp = Math.max(0, (target.hp||0) - 2);
    caller.hp = Math.min(20, (caller.hp||20) + 2);

    if(target.hp <= 0) target.alive = false;

    io.to(roomCode).emit("playerUpdated", { id: targetId, hp: target.hp, alive: target.alive });
    io.to(roomCode).emit("playerUpdated", { id: callerId, hp: caller.hp });

    // record history item for a duel
    history.push({ ts: Date.now(), winnerName: caller.name, winnerCity: caller.city || "", loserName: target.name, roomCode });
  });

  socket.on("pauseMatch", ({ roomCode }) => {
    const room = rooms.get(roomCode); if(!room) return;
    room.paused = true;
    io.to(roomCode).emit("paused", { by: socket.id, until: Date.now()+8000 });
  });

  socket.on("resumeMatch", ({ roomCode }) => {
    const room = rooms.get(roomCode); if(!room) return;
    room.paused = false;
    io.to(roomCode).emit("gameResumed");
  });

  // End match → determine winner, bump wins leaderboard
  socket.on("endMatch", ({ roomCode }) => {
    const room = rooms.get(roomCode); if(!room) return;
    const alive = room.players.filter(p=>p.alive && p.hp>0);
    const winner = alive[0] || room.players.find(Boolean);
    if(!winner) return;

    const key = winsKey(winner.name, winner.city||"");
    const row = leaderboard.get(key) || { name: winner.name, city: winner.city||"", wins: 0 };
    row.wins += 1; leaderboard.set(key, row);

    io.to(roomCode).emit("matchEnded", { winner: row });
    // reset used animals for next game if you want:
    // room.used = new Set(room.players.filter(p=>p.alive).map(p=>p.animal));
  });

  socket.on("disconnect", () => {
    for (const [code, room] of rooms) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if(idx>=0){
        room.players.splice(idx,1);
        io.to(code).emit("playerList", room.players);
      }
    }
  });
});

// ----- Start -----
server.listen(PORT, () => console.log(`✅ API & Realtime on :${PORT}`));
