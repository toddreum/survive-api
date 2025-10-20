import express from "express";
import cors from "cors";
import crypto from "crypto";
import Redis from "ioredis";
import Stripe from "stripe";

// -------- Config --------
const ORIGIN       = process.env.ORIGIN || "https://survive.com"; // your site (CORS)
const REDIS_URL    = process.env.REDIS_URL || "";                 // optional persistence
const STRIPE_SECRET= process.env.STRIPE_SECRET || "";             // required for paid flows
const SUPPORT_LINK = process.env.SUPPORT_LINK || "";              // optional: Stripe Payment Link
const PUBLIC_BASE  = process.env.PUBLIC_BASE  || ORIGIN;          // where to send users back (your site)
const stripe = STRIPE_SECRET ? new Stripe(STRIPE_SECRET) : null;

// -------- Storage (Redis if set, else in-memory) --------
let memory = { listMap: new Map(), rooms: new Map(), publicRooms: new Map() };
let redis = REDIS_URL ? new Redis(REDIS_URL, { tls: REDIS_URL.startsWith("rediss://") ? {} : undefined }) : null;

const kDay    = (day)          => `lb:day:${day}`;
const kRegion = (region, day)  => `lb:region:${region}:${day}`;
const kRoom   = (id)           => `room:${id}`;
const kPublic = `public:rooms`;

async function pushList(key, item){ if(redis) return redis.rpush(key, JSON.stringify(item));
  const a = memory.listMap.get(key) || []; a.push(item); memory.listMap.set(key, a); }
async function getList(key){ if(redis) return (await redis.lrange(key, 0, -1)).map(s=>JSON.parse(s));
  return memory.listMap.get(key) || []; }
async function setJSON(key, obj){ if(redis) return redis.set(key, JSON.stringify(obj)); memory.rooms.set(key, obj); }
async function getJSON(key){ if(redis){ const s = await redis.get(key); return s?JSON.parse(s):null; } return memory.rooms.get(key) || null; }
async function pushPublicRoom(room){ if(redis) return redis.hset(kPublic, room.id, JSON.stringify(room)); memory.publicRooms.set(room.id, room); }
async function listPublicRooms(){ if(redis){ const all = await redis.hgetall(kPublic); return Object.entries(all).map(([id, json])=>({ id, ...JSON.parse(json) })); }
  return [...memory.publicRooms.values()]; }

// -------- Server --------
const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(cors({ origin: ORIGIN, credentials: true }));

app.get("/api/health", (_req,res)=>res.json({ok:true}));

// submit single-player result
app.post("/api/submit", async (req,res)=>{
  try{
    const name   = (req.header("X-Player-Name") || "Anonymous").toString().slice(0,24);
    const region = (req.header("X-Region") || "UTC").toString().slice(0,64);
    const { day, scenarioId, win, hp, ts, mode="veteran" } = req.body || {};
    if(!day || typeof hp!=="number") return res.status(400).json({error:"bad payload"});
    const entry = { name, win:!!win, hp:Math.max(0,Math.min(5,hp)), ts:ts||Date.now(), scenarioId:scenarioId||"", mode };
    await pushList(kDay(day), entry);
    await pushList(kRegion(region, day), { ...entry, region });
    res.json({ok:true});
  }catch{ res.status(500).json({error:"server error"}); }
});

// global leaderboard
app.get("/api/leaderboard", async (req,res)=>{
  try{
    const day = req.query.day;
    if(!day) return res.status(400).json({error:"missing day"});
    const rows = await getList(kDay(day));
    const top = rows.slice().sort((a,b)=>(b.win-a.win)||(b.hp-a.hp)||(a.ts-b.ts)).slice(0,100);
    res.json({top});
  }catch{ res.status(500).json({error:"server error"}); }
});

// region leaderboard
app.get("/api/region/leaderboard", async (req,res)=>{
  try{
    const { region, day } = req.query;
    if(!region || !day) return res.status(400).json({error:"missing params"});
    const rows = await getList(kRegion(region, day));
    const top = rows.slice().sort((a,b)=>(b.win-a.win)||(b.hp-a.hp)||(a.ts-b.ts)).slice(0,100);
    res.json({top});
  }catch{ res.status(500).json({error:"server error"}); }
});

// rooms
app.post("/api/room", async (req,res)=>{
  try{
    const name = (req.header("X-Player-Name") || "Anonymous").toString().slice(0,24);
    const { mode="duel", day="", scenarioId="", region="UTC", isPublic=false } = req.body || {};
    const id = crypto.randomBytes(3).toString("hex");
    const room = { id, mode, day, scenarioId, region, players:[name], results:[] };
    await setJSON(kRoom(id), room);
    if(isPublic) await pushPublicRoom({ id, count:1, max:10 });
    res.json({ roomId:id });
  }catch{ res.status(500).json({error:"server error"}); }
});
app.post("/api/room/join", async (req,res)=>{
  try{
    const name = (req.header("X-Player-Name") || "Anonymous").toString().slice(0,24);
    const { roomId } = req.body || {};
    const key = kRoom(roomId); const room = await getJSON(key);
    if(!room) return res.status(404).json({error:"room not found"});
    if(!room.players.includes(name)) room.players.push(name);
    await setJSON(key, room);
    res.json({ok:true});
  }catch{ res.status(500).json({error:"server error"}); }
});
app.post("/api/room/submit", async (req,res)=>{
  try{
    const name = (req.header("X-Player-Name") || "Anonymous").toString().slice(0,24);
    const { roomId, day, scenarioId, win, hp, ts, mode="veteran" } = req.body || {};
    const key = kRoom(roomId); const room = await getJSON(key);
    if(!room) return res.status(404).json({error:"room not found"});
    if(!room.players.includes(name)) room.players.push(name);
    room.results.push({ name, day, scenarioId, win:!!win, hp:Math.max(0,Math.min(5,hp||0)), ts:ts||Date.now(), mode });
    await setJSON(key, room);
    res.json({ok:true});
  }catch{ res.status(500).json({error:"server error"}); }
});
app.get("/api/room/leaderboard", async (req,res)=>{
  try{
    const key = kRoom(req.query.room);
    const room = await getJSON(key);
    const rows = room?.results || [];
    const top = rows.slice().sort((a,b)=>(b.win-a.win)||(b.hp-a.hp)||(a.ts-b.ts)).slice(0,100);
    res.json({top});
  }catch{ res.status(500).json({error:"server error"}); }
});
app.get("/api/public/list", async (_req,res)=>{
  try{ res.json({ rooms: await listPublicRooms() }); }
  catch{ res.status(500).json({ rooms: [] }); }
});

// -------- Monetization --------

// Support: return a configured Payment Link (no server-side Stripe needed)
app.get("/api/pay/support-link", (_req, res)=>{
  if(!SUPPORT_LINK) return res.status(400).json({error:"support_link_not_set"});
  res.json({url: SUPPORT_LINK});
});

// Create Checkout session for Revive (+2 HP)
app.post("/api/pay/revive", async (req,res)=>{
  try{
    if(!stripe) return res.status(400).json({error:"stripe_not_configured"});
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        price_data:{
          currency:"usd",
          product_data:{ name:"Revive (+2 HP)" },
          unit_amount: 99
        },
        quantity:1
      }],
      metadata:{ type:"revive" },
      success_url: `${PUBLIC_BASE}/?paid=revive&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_BASE}/?canceled=1`
    });
    res.json({url: session.url});
  }catch(e){ res.status(500).json({error:"stripe_error"}); }
});

// Create Checkout session for Premium Theme
app.post("/api/pay/premium", async (req,res)=>{
  try{
    if(!stripe) return res.status(400).json({error:"stripe_not_configured"});
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        price_data:{
          currency:"usd",
          product_data:{ name:"Premium Theme (one-time)" },
          unit_amount: 499
        },
        quantity:1
      }],
      metadata:{ type:"premium" },
      success_url: `${PUBLIC_BASE}/?paid=premium&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_BASE}/?canceled=1`
    });
    res.json({url: session.url});
  }catch(e){ res.status(500).json({error:"stripe_error"}); }
});

// Verify a completed session (used by frontend after redirect)
app.get("/api/pay/verify", async (req,res)=>{
  try{
    if(!stripe) return res.status(400).json({error:"stripe_not_configured"});
    const sid = req.query.session_id;
    if(!sid) return res.status(400).json({error:"missing_session_id"});
    const session = await stripe.checkout.sessions.retrieve(sid);
    const paid = session?.payment_status === "paid";
    const type = session?.metadata?.type || "";
    res.json({paid, type});
  }catch(e){ res.status(500).json({error:"stripe_error"}); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> {
  console.log(`Survive API on :${PORT}`);
  console.log(`CORS origin: ${ORIGIN}`);
  console.log(REDIS_URL ? "Redis: ON" : "Redis: OFF (memory only)");
  console.log(STRIPE_SECRET ? "Stripe: ON" : "Stripe: OFF");
});
