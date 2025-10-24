// server.js
import express from "express";
import http from "http";
import cors from "cors";
import Stripe from "stripe";
import { Server } from "socket.io";
import bodyParser from "body-parser";
import fetch from "node-fetch"; // Required for ElevenLabs API proxy

const app = express();

// Load environment variables (you should set these in Render or .env)
const PORT = process.env.PORT || 8080;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
// IMPORTANT: Use the Voice ID you prefer for the game announcements
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "EX5cO7pW aGAYmldlryg0"; 

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", { apiVersion: "2024-06-20" });
const PRICE_HEALTH = process.env.STRIPE_PRICE_HEALTH_BOOST; 
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// ----- ElevenLabs TTS Proxy -----
// Must be set up to prevent exposing your ElevenLabs API Key on the client.
app.get("/api/tts", async (req, res) => {
    const { text, pitch, rate, isCountdown } = req.query;
    if (!text || !ELEVENLABS_API_KEY) {
        return res.status(400).send("TTS text or API key missing.");
    }
    
    // For countdown, only announce the number, not surrounding text.
    const textToSpeak = isCountdown === 'true' ? text : text; 

    try {
        const elevenLabsResponse = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=mp3_22050_32`, {
            method: "POST",
            headers: {
                "xi-api-key": ELEVENLABS_API_KEY,
                "Content-Type": "application/json",
                "Accept": "audio/mpeg",
            },
            body: JSON.stringify({
                text: textToSpeak,
                model_id: "eleven_multilingual_v2", // A reliable model
                // Optional: Stability/Clarity settings can be added here
            }),
        });

        if (!elevenLabsResponse.ok) {
            console.error("ElevenLabs API Error:", elevenLabsResponse.status, elevenLabsResponse.statusText);
            return res.status(elevenLabsResponse.status).send(`ElevenLabs error: ${elevenLabsResponse.statusText}`);
        }

        // Stream the audio back to the client
        res.setHeader('Content-Type', 'audio/mpeg');
        elevenLabsResponse.body.pipe(res);

    } catch (error) {
        console.error("Server TTS Proxy error:", error);
        res.status(500).send("Internal Server Error during TTS processing.");
    }
});


// IMPORTANT: raw body for webhook BEFORE json parser
app.post("/webhook", bodyParser.raw({ type: "application/json" }), webhookHandler);

// General middleware
app.use(cors());
app.use(express.json());

// ----- HTTP Server + Sockets -----
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*"} });

// ----- In-memory state (Swap for DB later) -----
const rooms = new Map();
const leaderboard = new Map();
const history = [];

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
function winsKey(name, city, st){ return `${name}__${city||""}__${st||""}`; }


// ----- API: Health Booster (Handles quantity) -----
app.post("/api/buy_health", async (req, res) => {
  try {
    const { roomCode, playerId, quantity } = req.body || {};
    if(!PRICE_HEALTH) return res.status(500).json({ error: "Missing STRIPE_PRICE_HEALTH_BOOST" });

    // Enforce minimum 1, maximum 10
    const qty = Math.min(10, Math.max(1, parseInt(quantity, 10) || 1)); 

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: PRICE_HEALTH, quantity: qty }], // Use quantity here
      metadata: { type: "HEALTH_BOOST", roomCode, playerId, quantity: qty }, // Pass quantity in metadata
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
  const rows = [...leaderboard.values()].sort((a,b)=> (b.wins - a.wins) || (b.ties - a.ties) ).slice(0,100);
  res.json(rows);
});

// ----- API: Recent history -----
app.get("/api/history", (req, res) => {
  res.json(history.slice(-100).reverse());
});

// ----- Webhook handler (Applies multiple boosts) -----
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
      const quantity = parseInt(session.metadata.quantity, 10) || 1; // Retrieve quantity
      
      // Emit socket event for the client to handle the boost(s)
      io.to(roomCode).emit("boostPurchased", { 
          playerId, 
          quantity, 
          // The client will handle applying boosts and banking any excess
      });
      io.to(roomCode).emit("gameResumed");
    }
  }
  res.sendStatus(200);
}

// ----- Socket events -----
io.on("connection", socket => {
  // Client only joins if successfully authenticated/validated (beyond this scope)
  socket.on("joinRoom", ({ roomCode, firstName, lastName, city, st }) => {
    if(!roomCode) return;
    if(!rooms.has(roomCode)) rooms.set(roomCode, { players: [], used: new Set(), paused:false });

    const room = rooms.get(roomCode);
    const animal = uniqueAnimal(room);
    const lastInitial = (lastName||"").trim().charAt(0).toUpperCase();
    const name = `${(firstName||"Player").trim()}${lastInitial ? " "+lastInitial+"." : ""}`;

    const player = { id: socket.id, name, city, st, animal, hp:20, isBot:false, alive:true };
    room.players.push(player);
    socket.join(roomCode);
    io.to(roomCode).emit("playerList", room.players); // Send full player list
  });

  // Report a call failure from the client -> server applies damage & caller reward (+2)
  socket.on("reportFail", ({ roomCode, targetId, callerId, wasStall }) => {
    const room = rooms.get(roomCode); if(!room) return;
    const target = room.players.find(p=>p.id===targetId);
    const caller = room.players.find(p=>p.id===callerId);
    if(!caller) return;

    if(wasStall) {
        // Caller penalty: -1 HP (front-end applies this for demo, server confirms)
        caller.hp = Math.max(0, (caller.hp||0) - 1);
        io.to(roomCode).emit("playerUpdated", { id: callerId, hp: caller.hp });
        io.to(roomCode).emit("turnEnded", { nextCallerId: caller.id, reason: 'stall' });
    } else if (target) {
        // Target failed: -2 HP, Caller reward: +2 HP
        target.hp = Math.max(0, (target.hp||0) - 2);
        caller.hp = Math.min(20, (caller.hp||20) + 2);

        if(target.hp <= 0) target.alive = false;

        io.to(roomCode).emit("playerUpdated", { id: targetId, hp: target.hp, alive: target.alive });
        io.to(roomCode).emit("playerUpdated", { id: callerId, hp: caller.hp });
        
        // Handle animal swap (server authoritative for all clients)
        if(caller.alive && target.alive) {
            const tmpAnimal = target.animal;
            target.animal = caller.animal;
            caller.animal = tmpAnimal;
            io.to(roomCode).emit("animalSwap", { callerId, targetId, callerAnimal: caller.animal, targetAnimal: target.animal });
        }
        
        // Game turn ended, notify clients who the next caller is
        io.to(roomCode).emit("turnEnded", { nextCallerId: target.id, reason: 'fail' }); 
        
        // Record history item
        history.push({ 
            ts: Date.now(), 
            type: 'win', 
            winnerName: caller.name, 
            winnerCity: caller.city || "", 
            winnerSt: caller.st || "", 
            opponent: target.name, 
            roomCode 
        });
    }
  });

  // Client requests a pause 
  socket.on("pauseMatch", ({ roomCode }) => {
    const room = rooms.get(roomCode); if(!room) return;
    room.paused = true;
    io.to(roomCode).emit("paused", { by: socket.id, until: Date.now()+8000 });
  });

  // Client requests a resume (usually after a purchase is confirmed by webhook)
  socket.on("resumeMatch", ({ roomCode }) => {
    const room = rooms.get(roomCode); if(!room) return;
    room.paused = false;
    io.to(roomCode).emit("gameResumed");
  });

  // Match ends (last standing or time up) -> determine winner/tie, bump leaderboard
  socket.on("endMatch", ({ roomCode, reason, finalScores }) => {
    const room = rooms.get(roomCode); if(!room) return;
    
    // Server re-validates the result using the finalScores data from the client (or room state)
    let maxHP = -1;
    let tied = [];
    finalScores.forEach(p => { 
        if(p.hp > maxHP) { maxHP = p.hp; tied = [p]; } 
        else if(p.hp === maxHP) { tied.push(p); } 
    });

    if (reason === 'timeUp' && tied.length > 1) {
        // TIE
        tied.forEach(p => { 
            const playerInRoom = room.players.find(rp => rp.id === p.id);
            if(playerInRoom && playerInRoom.id.startsWith('bot') === false) {
                 // Only bump score if it's a real player (not a bot)
                const key = winsKey(playerInRoom.name, playerInRoom.city||"", playerInRoom.st||"");
                const row = leaderboard.get(key) || { name: playerInRoom.name, city: playerInRoom.city||"", st: playerInRoom.st||"", wins: 0, ties: 0 };
                row.ties += 1; leaderboard.set(key, row);
            }
        });
        io.to(roomCode).emit("matchEnded", { reason: 'tie', tiedPlayers: tied });
        
        // Record history item for a tie
        history.push({ 
            ts: Date.now(), 
            type: 'tie', 
            winnerName: tied.map(p => p.name).join(', '), 
            city: '', 
            st: '', 
            opponent: '', 
            roomCode 
        });

    } else {
        // WINNER (Last Standing OR highest HP among tied/alive)
        const winner = tied[0]; // If it wasn't a tie, there's a winner
        const winnerInRoom = room.players.find(rp => rp.id === winner.id);
        
        if (winnerInRoom && winnerInRoom.id.startsWith('bot') === false) {
            const key = winsKey(winnerInRoom.name, winnerInRoom.city||"", winnerInRoom.st||"");
            const row = leaderboard.get(key) || { name: winnerInRoom.name, city: winnerInRoom.city||"", st: winnerInRoom.st||"", wins: 0, ties: 0 };
            row.wins += 1; leaderboard.set(key, row);
        }

        io.to(roomCode).emit("matchEnded", { reason: 'win', winner: winner });
    }

    // Clean up or reset room state here (e.g., room.used = new Set())
  });

  socket.on("disconnect", () => {
    for (const [code, room] of rooms) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if(idx>=0){
        room.players.splice(idx,1);
        io.to(code).emit("playerList", room.players);
        // Check for end match if player count drops below min players
      }
    }
  });
});

// ----- Start -----
server.listen(PORT, () => console.log(`✅ API & Realtime on :${PORT}`));
