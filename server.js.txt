import express from "express";
import cors from "cors";
import crypto from "crypto";
import Redis from "ioredis";

// ---------- Super simple config ----------
const ORIGIN = process.env.ORIGIN || "https://survive.com";
// If you skip Redis for now, the server will use in-memory storage.
// (Memory resets on restart; Redis makes it persistent.)
const REDIS_URL = process.env.REDIS_URL || ""; // e.g. rediss://:pass@host:port

// ---------- Storage layer (auto-fallback) ----------
let db = {
  // in-memory as fallback
  leaderboard: new Map(),             // key: day => [{name, win, hp, ts}]
  regionLeaderboard: new Map(),       // key: region|day => [...]
  rooms: new Map(),                   // key: roomId => {mode, day, scenarioId, region, players: Set<string>, results: []}
  publicRooms: new Map(),             // key: roomId => {count, max}
};
let redis = null;
if (REDIS_URL) {
  redis = new Redis(REDIS_URL, { tls: REDIS_URL.startsWith("rediss://") ? {} : undefined });
}

// Helpers for keys
const kDay = (day) => `lb:day:${day}`;
const kRegion = (region, day) => `lb:region:${region}:${day}`;
const kRoom = (id) => `room:${id}`;
const kPublic = `public:rooms`;

// Save/get helpers (use Redis if available; otherwise memory)
async function pushList(key, item) {
  if (redis) return redis.rpush(key, JSON.stringify(item));
  const list = db.leaderboard.get(key) || [];
  list.push(item);
  db.leaderboard.set(key, list);
}
async function getList(key) {
  if (redis) {
    const arr = await redis.lrange(key, 0, -1);
    return arr.map((s) => JSON.parse(s));
  }
  return db.leaderboard.get(key) || [];
}
async function setJSON(key, obj) {
  if (redis) return redis.set(key, JSON.stringify(obj));
  db.rooms.set(key, obj);
}
async function getJSON(key) {
  if (redis) {
    const s = await redis.get(key);
    return s ? JSON.parse(s) : null;
  }
  return db.rooms.get(key) || null;
}
async function pushPublicRoom(room) {
  if (redis) return redis.hset(kPublic, room.id, JSON.stringify(room));
  db.publicRooms.set(room.id, room);
}
async function listPublicRooms() {
  if (redis) {
    const all = await redis.hgetall(kPublic);
    return Object.entries(all).map(([id, json]) => ({ id, ...JSON.parse(json) }));
  }
  return [...db.publicRooms.values()];
}

// ---------- Server ----------
const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(cors({ origin: ORIGIN, credentials: true }));

// Health check
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// 1) Submit single-player result
app.post("/api/submit", async (req, res) => {
  try {
    const name = (req.header("X-Player-Name") || "Anonymous").toString().slice(0, 24);
    const region = (req.header("X-Region") || "UTC").toString().slice(0, 64);
    const { day, scenarioId, win, hp, ts } = req.body || {};
    if (!day || typeof hp !== "number") return res.status(400).json({ error: "bad payload" });

    const entry = { name, win: !!win, hp: Math.max(0, Math.min(5, hp)), ts: ts || Date.now(), scenarioId: scenarioId || "" };
    // Global day leaderboard
    await pushList(kDay(day), entry);
    // Region day leaderboard
    await pushList(kRegion(region, day), { ...entry, region });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "server error" });
  }
});

// 2) Global leaderboard
app.get("/api/leaderboard", async (req, res) => {
  try {
    const day = req.query.day;
    if (!day) return res.status(400).json({ error: "missing day" });
    const rows = await getList(kDay(day));
    // Simple rank: wins first, then higher HP, then earlier ts
    const top = rows
      .slice()
      .sort((a, b) => (b.win - a.win) || (b.hp - a.hp) || (a.ts - b.ts))
      .slice(0, 100);
    res.json({ top });
  } catch (e) {
    res.status(500).json({ error: "server error" });
  }
});

// 3) Region leaderboard
app.get("/api/region/leaderboard", async (req, res) => {
  try {
    const { region, day } = req.query;
    if (!region || !day) return res.status(400).json({ error: "missing params" });
    const rows = await getList(kRegion(region, day));
    const top = rows
      .slice()
      .sort((a, b) => (b.win - a.win) || (b.hp - a.hp) || (a.ts - b.ts))
      .slice(0, 100);
    res.json({ top });
  } catch (e) {
    res.status(500).json({ error: "server error" });
  }
});

// 4) Rooms (friends/public)
// Create room
app.post("/api/room", async (req, res) => {
  try {
    const name = (req.header("X-Player-Name") || "Anonymous").toString().slice(0, 24);
    const { mode = "duel", day = "", scenarioId = "", region = "UTC", isPublic = false } = req.body || {};
    const id = crypto.randomBytes(3).toString("hex"); // short code
    const room = { id, mode, day, scenarioId, region, players: [name], results: [] };
    await setJSON(kRoom(id), room);
    if (isPublic) await pushPublicRoom({ id, count: 1, max: 10 });
    res.json({ roomId: id });
  } catch (_e) {
    res.status(500).json({ error: "server error" });
  }
});

// Join room
app.post("/api/room/join", async (req, res) => {
  try {
    const name = (req.header("X-Player-Name") || "Anonymous").toString().slice(0, 24);
    const { roomId } = req.body || {};
    const key = kRoom(roomId);
    const room = (await getJSON(key)) || null;
    if (!room) return res.status(404).json({ error: "room not found" });
    if (!room.players.includes(name)) room.players.push(name);
    await setJSON(key, room);
    res.json({ ok: true });
  } catch (_e) {
    res.status(500).json({ error: "server error" });
  }
});

// Submit result to room
app.post("/api/room/submit", async (req, res) => {
  try {
    const name = (req.header("X-Player-Name") || "Anonymous").toString().slice(0, 24);
    const { roomId, day, scenarioId, win, hp, ts } = req.body || {};
    const key = kRoom(roomId);
    const room = (await getJSON(key)) || null;
    if (!room) return res.status(404).json({ error: "room not found" });
    // upsert player
    if (!room.players.includes(name)) room.players.push(name);
    // push result
    room.results.push({ name, day, scenarioId, win: !!win, hp: Math.max(0, Math.min(5, hp || 0)), ts: ts || Date.now() });
    await setJSON(key, room);
    res.json({ ok: true });
  } catch (_e) {
    res.status(500).json({ error: "server error" });
  }
});

// Room leaderboard
app.get("/api/room/leaderboard", async (req, res) => {
  try {
    const { room } = req.query;
    const key = kRoom(room);
    const data = (await getJSON(key)) || null;
    if (!data) return res.json({ top: [] });
    const rows = data.results || [];
    const top = rows
      .slice()
      .sort((a, b) => (b.win - a.win) || (b.hp - a.hp) || (a.ts - b.ts))
      .slice(0, 100);
    res.json({ top });
  } catch (_e) {
    res.status(500).json({ error: "server error" });
  }
});

// Public rooms list
app.get("/api/public/list", async (_req, res) => {
  try {
    const rooms = await listPublicRooms();
    res.json({ rooms });
  } catch (_e) {
    res.status(500).json({ rooms: [] });
  }
});

// (Optional) Stripe stubs (you can ignore for now; the UI will show a friendly message)
app.post("/api/pay/revive", (_req, res) => {
  return res.status(400).json({ error: "revive not configured" });
});
app.get("/api/pay/verify", (_req, res) => {
  return res.json({ paid: false });
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Survive API up on :${PORT}`);
  console.log(`Allowing CORS origin: ${ORIGIN}`);
  console.log(REDIS_URL ? "Using Redis storage ✅" : "Using in-memory storage (no Redis) ⚠️");
});
